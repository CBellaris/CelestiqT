# BSDF
这一节，我们拓展一下材质系统，添加透射材质，即水、玻璃等，也就是BTDF(Transmittance)，组合一下，也可以叫BSDF(Scattering)

先向材质中添加两个参数：
```glsl
float ior;          // 折射率，空气≈1.0，玻璃≈1.5
float transmission; // 透射能量占比（“透明度”）
```
然后需要在每次采样开始（反弹循环开始前）定义一些变量：
```glsl
// 维护透射变量
float etaExt = 1.0;     // 外侧的 η­­
float etaInt = 1.0;     // 进入物体的 η
bool  inside = false;   // 当前光线是否在介质内
```
在每次反弹中，获取材质时：
```glsl
float transmission = mat.transmission;
if(!inside) {
    etaInt = mat.ior;       // 若在外侧（空气中）准备进入物体
}
bool sampledTransmission = false;   // 此次反弹有没有采样透射
```


## 菲涅尔（介电）
首先需要升级一下之前比较简略的估算各分支能量占比的方法：
```glsl
// --- 用Fresnel估算各分支能量占比---
vec3 F0 = mix(vec3(0.04), albedo, metallic);
vec3 F_approx;
if(metallic > 0.0)
    F_approx = fresnelSchlickRoughness(clamp(dot(N, V), 0.0, 1.0), F0, roughness);
else
    F_approx = vec3(fresnelDielectric(clamp(dot(N, V), 0.0, 1.0), etaExt, etaInt));

// 镜面 / 透射 / 漫反射 强度（标量化）
float wS = dot(F_approx, vec3(0.2126,0.7152,0.0722));              // 镜面（亮度）
float wT = (1.0 - metallic) * transmission
         * dot(vec3(1.0) - F_approx, vec3(0.2126,0.7152,0.0722));   // 透射
float wD = (1.0 - metallic) * (1.0 - transmission)
         * dot(vec3(1.0) - F_approx, vec3(0.2126,0.7152,0.0722));   // 漫反射
float sumW = wS + wD + wT + 1e-6;

// 混合采样分支概率 （让 选择权重 与能量占比一致）
float  pdfSelSpec    = wS / sumW;   // 镜面分支
float  pdfSelTrans   = wT / sumW;   // 透射分支
float  pdfSelDiffuse = wD / sumW;   // 漫反射分支
```
透明度和金属度是互斥的，金属不可能有任何透明效果，而塑料等可以混合一定的透明度。所以以此为分界，对任何`metallic > 0.0`的物体，还是沿用之前的菲涅尔函数，而其他的使用一个支持介电材质的菲涅尔函数，然后将其转换为能量占比标量，这里点乘一个`vec3(0.2126,0.7152,0.0722)`，因为人眼对绿色最敏感，不过平均分配其实也没太大问题

## 透射分支
直接光源采样可以加入透射，但非常困难，要从光源到某点（中间有透射物体）构建光路。这么做主要是为了焦散效果，也就是光源穿过透明物体形成的光斑，实现焦散效果有很多方法，例如双向路径追踪或者光子映射等，升级直接光源采样（关键词MNEE）以支持透射是最麻烦的一个方法，本节就先不考虑实现了，后面可能实现一下photon mapping

所以只简单的在后面的混合采样中添加一个透射分支：
```glsl
if (rTech < pdfSelSpec)      // --- 镜面分支：GGX importance sample ---
{
    H = ImportanceSampleGGX(Xi, N, roughness);
    L2     = normalize(reflect(-V, H));                               
} else if(rTech < pdfSelSpec + pdfSelDiffuse) // --- 漫反射分支：余弦加权 ---
{
    L2     = cosineSampleHemisphere(Xi, N);
    H      = normalize(V + L2); // 计算 H 向量    
} else                         // --- 透射分支：GGX importance sample ---
{
    sampledTransmission = true;
    H = ImportanceSampleGGX(Xi, N, roughness);
    float eta = etaExt / etaInt;
    vec3 T = refract(-V, H, eta);
    if (length(T) == 0.0) {      // 回退为漫反射/镜面分支
        sampledTransmission = false;
        L2     = normalize(reflect(-V, H));  
    }else{
        L2     = T;
        H = normalize(V * eta + T);  // 透射 Half-vector 定义
        if (dot(N, H) < 0.0) H = -H;    // 保证 N·H ≥ 0
    }
}
```
很直观，`refract()`是一个glsl内建的函数，直接就可以计算折射的方向，当不存在折射时（玻璃进入空气，并且入射角过大），其约定返回0向量，此时回退为镜面分支即可。若成功采样了透射光线，标记`sampledTransmission`为true

然后是BSDF和PDF的计算，由于透射和漫反射/反射不在一个半球，因此不太好将这些计算混合在一起，也可以考虑将漫反射/反射拓展至全球面定义，但没什么太大必要，简单的分开计算就可以了：
```glsl
if(sampledTransmission){
    vec3 F = vec3(fresnelDielectric(cosTheta, etaExt, etaInt)); 
    // 透射项
    // ---Physically Based Rendering 4ed (eq 9.37 & 9.40)---
    float eta = etaExt / etaInt;
    float VdotH = dot(V, H);
    float HdotL2 = dot(H, L2);
    float denom = (VdotH + HdotL2/eta);
    denom       = max(1e-4, denom*denom);
    float nom = abs(dot(V,N)) * abs(dot(L2,N));
    vec3 trans  = abs(VdotH) * abs(HdotL2) * albedo * (1.0 - F) * G * NDF / (denom * nom);  // (eq 9.40)
    float NdotH = abs(dot(N, H));
    float pdfTrans = (NDF * NdotH * abs(dot(L2,H))) / denom; //(eq 9.37)

    // ---简化近似版---
    // float transmissionWeight = transmission      
    //          * (1.0 - metallic); 
    // // 可给玻璃一点着色 (albedo)，也可用 vec3(1.0)
    // vec3 trans = transmissionWeight * vec3(1.0) / PI;
    //float pdfTrans = abs(dot(N, L2)) / PI; 

    f_bsdf = trans;
    pdfCombined = pdfSelTrans * pdfTrans;
    misW = 1.0f;
}
```
当采样了透射光线时，默认用介电菲涅尔，直接令BSDF结果为透射项`f_bsdf = trans`，不计算反射和漫射项，`pdfCombined`同理，MIS权重也直接忽略，会有一些能量守恒上的问题，但要把整个透射统一到前一章的框架里头，实在有点困难，就先偷个懒了。这里的公式都来自 https://pbr-book.org/4ed/contents 第9.7节，只是为了毛玻璃这样的效果的话，可以考虑换成下面的简化版，会快一些，而且效果基本不会差特别的多

```glsl
// 接上
else{
    vec3 F;
    if(metallic > 0.0)
        F = fresnelSchlickRoughness(cosTheta, F0, roughness);
        
    else
        F = vec3(fresnelDielectric(cosTheta, etaExt, etaInt));
    vec3 spec   = (NDF * G * F) / (4.0 * NdotV * NdotL2 + 1e-4);
    vec3 kD = vec3(1.0) - F;
    kD *= (1.0 - metallic) * (1.0 - transmission);    
    vec3 diff   = kD * albedo / PI;
    f_bsdf = spec + diff;
    float NdotH = max(dot(N, H), 0.0);
    float HdotV = max(dot(H, V), 0.0);
    float pdfSpec = NDF * NdotH / (4.0 * HdotV + 1e-4);     
    float pdfDiff      = abs(dot(N, L2)) / PI;  
    pdfCombined = pdfSelSpec*pdfSpec + pdfSelDiffuse*pdfDiff;
    misW    = (pdfCombined*pdfCombined) /
              (pdfCombined*pdfCombined + pdfLight*pdfLight);
}
```
漫射/反射同前一章，根据不同材质选择不同菲涅尔函数即可

最后更新一下折射率等信息：
```glsl
// 透射更新
if (sampledTransmission) {
    inside = !inside;
    // 交换内外折射率，供下一次 bounce 使用
    float tmp = etaExt;
    etaExt = etaInt;
    etaInt = tmp;
}
```

## 方向光
之前的方向光只是留了个框架，还没测试过，实际上有bug（方向反了），现在顺手升级一下软阴影效果，先添加一个参数`angularRadius`：
```glsl
struct DirectionalLight {
    vec3 direction; // 单位向量
    vec3 color;
    float intensity;
    float angularRadius;
};
```
为弧度制，表示方向光在锥形区域采样，此锥形的最大角度，一般自然太阳光2~3度，再往上阴影就比较软了

修改方向光采样：
```glsl
LightSample sampleDirectionalLight(vec2 Xi)  
{
    DirectionalLight d = directionalLights[0];              // 仅支持 1 个方向光
    float thetaMax     = d.angularRadius;                    // 半角
    float cosThetaMax  = cos(thetaMax);
    float coneSolidAngle = 2.0 * PI * (1.0 - cosThetaMax);

    LightSample ls;
    ls.radiance = d.color * d.intensity / coneSolidAngle; 

    // 阴影：在圆锥内均匀采样
    float pdfSA;
    vec3  lDir = sampleCone(-d.direction, cosThetaMax, Xi, pdfSA);  // 指向光源，锥形采样
    ls.pos      = vec3(0.0);      // “无限远”光源，位置无意义
    ls.normal   = lDir;      
    ls.pdfArea  = pdfSA;            // solid-angle PDF
    ls.isDirectional = 1;         // 方向光
    return ls;
}
```
方向光现在就和面光一样，需要一个在半球上的`pdfSA = 1.0 / (2.0 * PI * (1.0 - cosThetaMax));`，还有这里的修正：`ls.radiance = d.color * d.intensity / coneSolidAngle;`，其实都可以用常数替代，因为`cosThetaMax`基本会只在一很小的一个范围里变动（thetaMax不能设置的太大，不然圆锥均匀采样效率比较低，需要升级），最后还是根据视觉效果调整intensity

## 构建
添加一个玻璃球和方向光，效果如下：

<img src="\assets\C10_0.png" style="zoom:50%;"/>
<img src="\assets\C10_1.png" style="zoom:50%;"/>

上图粗糙度为0.2，下图为最小值（0.04），折射率1.5

效果只能说马马虎虎，首先是边缘看上去比较黑，因为边缘都是反射，而现在的场景这个视角没有可以反射的东西，把这个玻璃球放在后面的盒子里，或者添加上天空盒会好很多

其次玻璃球还是纯黑阴影，因为目前的直接光源采样时，玻璃球依旧会普通的挡住光源，可以通过添加一些逻辑，例如按比例忽略透明物体来缓解，但治标不治本，不添加焦散效果，还是不真实。然后是两个常见aliasing：
1. 透明物体整体还是偏黑，因为缺少焦散/直接光源项，这个上面提过了，不添加这些整体视觉上就是会黑，可以通过提高透明物体的albedo（例如`mat.baseColor = glm::vec3(1.5f, 1.5f, 1.5f);`）来从视觉上弥补一下
2. 仔细看玻璃球，边缘处有径向的颜色/亮度分层，这个是由于大角度透射，加上现在用的GGX采样方法，导致此处光线变化很剧烈（视线移动一点，采样的光线会变化很大），随机向量还是出现了某种相关性，这个很玄学了，用粗糙透射采样就容易有这种问题，纯全透射不会。还是引入焦散相关算法来缓解，这里就先不展开了

## Side Quest
顺带简单提一些小的功能升级

## 天空盒
天空盒其实涉及到的内容还是比较多，例如IBL和CDF重要性采样等，但其实对于光追渲染来说，IBL其实视觉上提升不大，只是能加速收敛，这里就先跳过了，只是简单引入天空盒看看效果

由于不做IBL，就没有必要将HDR贴图转换为立方体贴图了，直接加载就行：
```cpp
// ./src/Scene.cpp
// void Scene::initScene()
uint32_t texture_0 = TextureManager::get().loadTexture("res/HDRI.hdr", VK_FORMAT_R32G32B32A32_SFLOAT);
s_sceneInfo.skyboxIndex = texture_0;    // 额外传入天空盒贴图的索引
```

然后在着色器中，若光线未击中任何物体，采样天空盒贴图，由于NEE中无天空盒光线采样，所以这里不用考虑MIS权重:
```glsl
if (!hitInfo.hit) {        
    // 将光线方向转换为等距柱状投影的UV坐标
    // phi (longitude): 范围 [-PI, PI]，从X轴开始
    // theta (latitude): 范围 [0, PI]，从Y轴开始
    float phi   = atan(rayDir.z, rayDir.x); // 
    float theta = acos(rayDir.y);  

    // u: [-PI, PI] -> [0, 1]
    // v: [0, PI] -> [0, 1]
    float u = phi / (2.0 * PI) + 0.5; 
    float v = theta / PI;    

    vec3 envRadiance = texture(textures[skyboxIndex], vec2(u, v)).rgb;
    radiance += throughput * envRadiance;
    break;
}
```
## 法线贴图
法线贴图涉及的内容其实不少，主要包括在cpu端正确计算顶点的切线，着色器中计算TBN矩阵，采样法线贴图并转换至世界坐标系，不过这些应该教程不少，具体原理和实现就省略了

我基本上是将之前在OpenGL渲染器中的代码复制过来，不过遇到了很奇怪的“手性”问题，法线贴图提供的阴影在某些方向是正确的，有些方向则计算反了。尝试了很多方法，包括翻转y轴，手动计算切线手性，一直没有完美解决，不同法线贴图的表现还不同，这个应该是多方面因素导致的，由于时间有限，没法系统性的研究这个问题，就暂时搁置了

## 模型导入
其实考虑到导入场景文件的话，仅支持一种格式是比较好的选择，例如tiny_gltf，无需额外编译且对PBR材质支持较好。但解析整个场景还是工作量太大，这里还是暂时选择使用assimp单独导入模型，然后手动添加其他的场景对象

只是用assimp导入模型的话是比较直接的，相关代码在./src/Mesh.h的Model类当中，简单讲讲怎么安装assimp和处理材质导入

https://github.com/assimp/assimp 同样是clone到./vender 

然后向tasks.json添加两个构建任务用于编译这个库：
```json
{
            "label": "cmake build assimp",
            "type": "shell",
            "command": "cmake",
            "args": [
                "--build",
                "${workspaceFolder}\\vender\\assimp\\build", // 指向构建目录
                "--config",
                "Debug" // 或 "Release"，根据需要
            ],
            "group": {
                "kind": "build",
                "isDefault": true
            },
            "problemMatcher": ["$gcc"]
        },
        {
            "label": "cmake configure assimp",
            "type": "shell",
            "command": "cmake",
            "args": [
                "${workspaceFolder}\\vender\\assimp",
                "-B",
                "${workspaceFolder}\\vender\\assimp\\build", // 指定构建目录
                "-G",
                "Visual Studio 17 2022" // 指定生成器
            ],
            "group": "none"
        },
```
同样先运行configure，再运行build，最后复制./vender/assimp/build/bin/Debug下的.dll和.pdb文件至./build

> **WIP**   *如果对这部分存在疑问，可以联系我补全*

