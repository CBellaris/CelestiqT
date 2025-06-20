# PBRT
这一章里，重点会聚焦在着色器代码，实现一个基础的路径追踪渲染器框架

## 整体框架
```glsl
// 计算着色器主循环-----------------------------------------------------------------
void main() {
    // ...

    // 性能常数
    const int MAX_BOUNCES = 8;
    const int SAMPLES_PER_PIXEL = 16;
    const float RUSSIAN_ROULETTE_PROB = 0.8;

    vec3 accumulateColor = vec3(0.0);

    // 每像素SAMPLES_PER_PIXEL次采样
    for (uint samples = 0; samples < SAMPLES_PER_PIXEL; ++samples) {
        // 生成 ray
        // ... 
        
        vec3 throughput = vec3(1.0);    // 光线当前bounce的能量
        vec3 radiance = vec3(0.0); 

        // 每次采样MAX_BOUNCES次反弹
        for (uint bounce = 0; bounce < MAX_BOUNCES; ++bounce) {
            // 场景射线追踪--------------------------------------------------------------
            HitInfo hitInfo;
            hitInfo.tWorld = 1e20;
            hitInfo.hit = false;

            traceTLAS_stack(tlasRoot, rayOrig, rayDir, hitInfo);

            // 检测沿此方向的光源--------------------------------------------------------
            // ...
            // 若击中，累积radiance并退出当前samples
            radiance += throughput * lightColor * lightIntensity;
            break;   

            // 获取材质-----------------------------------------------------------
            Material mat = materials[hitInfo.materialID];
            vec3 N = normalize(hitInfo.normal);
            vec3 V = -rayDir;
            vec3 albedo = mat.baseColor;
            float metallic = mat.metallic;
            float roughness = mat.roughness;

            // 光线采样、BRDF计算------------------------------------------------------------
            // ...
            vec3 brdf = kD * diffuse + specular;

            // 更新路径贡献
            // ...
            throughput *= brdf * NdotL / pdf;

            // 光线更新
            rayOrig = hitInfo.hitPos + N * 1e-4;
            rayDir = L;

            // 其他更新-----------------------------------------------------
            // Russian Roulette（从第三跳开始）
            // ...
        }
        accumulateColor += radiance;
    }
    accumulateColor /= float(SAMPLES_PER_PIXEL); // 平均

    // 帧间缓存
    vec3 prevColor = imageLoad(accumImage, ivec2(pixelCoord)).rgb;
    vec3 blended = (frameIndex == 0)
    ? accumulateColor
    : (prevColor * frameIndex + accumulateColor) / float(frameIndex + 1);

    imageStore(resultImage, ivec2(pixelCoord), vec4(blended, 1.0));
}
```
应该比较清晰了，标准的路径追踪流程，对于每个像素，采样SAMPLES_PER_PIXEL次，每次采样发出一根光线，反弹至打到光源/俄罗斯轮盘赌触发/达到MAX_BOUNCES等条件，结束当前采样

目前肯定是无法做到实时，添加一个**帧间缓存**机制，也就是当场景和摄像机都不动时，一直积累结果，并用总积累帧数平均。为此需要添加一个图像用于存储上一帧的结果，并且传入总积累帧数：
```glsl
// binding = 0: output image (储存最终颜色)
layout(set = 2, binding = 0, rgba32f) uniform writeonly image2D resultImage;
// binding = 1: accumulation image (储存累积颜色)
layout(set = 2, binding = 1, rgba32f) uniform readonly image2D accumImage;

// binding = 2: constants buffer
layout(set = 2, binding = 2) uniform Params {
    int frameIndex;
};
```
在每帧循环的最后，交换两张图片：
```cpp
// Renderer.cpp :468
// 计算着色器中的双图像交换
std::swap(r_computeImage_writeOnly, r_computeImage_readOnly);
bindImageOfComputePipeline();
```
目前我们不会交叉写入像素，所以也可以只用一张图片，先读出然后写入，但不够灵活，后面一些效果可能会写入其他像素（并非当前发出光线的像素），提前引入双图像交换机制是比较好的

在每帧写入常量缓冲区中的frameIndex，并累加++，然后在摄像机更新时重置其为0，我这里通过向摄像机中添加一个回调来实现：
```cpp
r_scene->getCamera()->addCameraUpdateCallback([this](){
        r_params.frameIndex = 0;
    });
```
## 光源求交
向着色器中添加：
```glsl
bool hitFaceLight(vec3 ro, vec3 rd, out float tMin, out vec3 color, out float intensity);
bool hitDirectionalLight(vec3 rayDir, out vec3 color, out float intensity);
```
面光源就是简单的和其顶点定义的三角形求交点，方向光的话可以计算一个光线和光源方向的夹角，大于某个阈值则视为命中，这个阈值可以视为光源的”软硬“，并添加边缘羽化过度

## 多维随机采样
这个我认为是理解起来比较难的部分，涉及到信号采样的理论知识到glsl中实现采样算法的难点，强烈建议看看 https://www.pbr-book.org/3ed-2018/contents 中的第7章 Sampling and Reconstruction和第13章 Monte Carlo Integration。目前主要关注构建低差异序列和如何引入高维扰动即可，这篇文章值得一看：

低差异序列（一）- 常见序列的定义及性质 - 文刀秋二的文章 - 知乎
https://zhuanlan.zhihu.com/p/20197323

我目前的解决方案如下：
```glsl
// 随机相关
struct RNGState { uint state; };   // 32-bit 状态，一条路径一个实例
RNGState rng_init(uvec2 pixel, uint frame, uint bounce);
uint rng_next(inout RNGState rng);
float rng_nextFloat(inout RNGState rng);
vec2 rng_nextFloat2(inout RNGState rng);
float sobolOwen(uint index, uint scramble, uint dim);
vec2 sobol2D(uint index, uint bounce, uint scramble);
```
首先是rng：
```glsl
uint splitmix32(uint x)
{
    x += 0x9e3779b9u;                 // 爬山常量 (φ·2³²)
    x ^= x >> 16;
    x *= 0x7feb352du;
    x ^= x >> 15;
    x *= 0x846ca68bu;
    x ^= x >> 16;
    return x;
}
RNGState rng_init(uvec2 pixel, uint frame, uint bounce)
{
    // 先把所有维度搅成一个 32-bit 值
    uint seed =
      (pixel.x * 1664525u)  ^ (pixel.y * 1013904223u) ^
      (frame   * 69069u)    ^ (bounce  * 362437u);

    seed = splitmix32(seed);      // 再做一次 avalanching
    return RNGState(seed | 1u);   // 避免 state==0
}
uint rng_next(inout RNGState rng)
{
    rng.state = rng.state * PCG32_MULT + PCG32_INC;         // LCG
    uint xorshifted = ((rng.state >> 18u) ^ rng.state) >> 27u;
    uint rot        = rng.state >> 28u;
    return (xorshifted >> rot) | (xorshifted << ((32u - rot) & 31u));
}
```
这里是一个PCG32系列的随机数生成器算法，基本上从LCG升级而来，适合解决LCG中的低维相关性问题，这里主要用于解耦每像素位置/帧时间的相关性，这里的bounce是个可选项，其在sobol算法中被打散效果会更好。具体原理说实话很难懂，用就完了

紧接着是sobol采样器：
```glsl
uint reverseBits(uint v)
{
    return bitfieldReverse(v);   // 反转 32 bit；高低位互换
}

// 单维 Owen scramble
float sobolOwen(uint index, uint scramble, uint dim) {
    index = reverseBits(index);
    index ^= splitmix32(scramble ^ dim);   // 每维扰动
    return float(index) * 2.3283064365386963e-10;
}

// 生成 (d0,d1) 两维，dPair 起点随 bounce 递增
vec2 sobol2D(uint index, uint bounce, uint scramble) {
    uint d0 = bounce * 2u + 0u;        // 每个 bounce 占两维
    uint d1 = bounce * 2u + 1u;
    return vec2(
        sobolOwen(index << 0u, scramble, d0),   // 维度哈希进 index
        sobolOwen(index << 0u, scramble, d1)
    );
}
```
这里的`index = reverseBits(index);`等价于构建了Van der Corput序列，剩下的参见上面说的文章，scramble传入RNGState，就能生成在：像素位置+帧时间+采样次数+反弹次数， 五个维度”均匀“分布的点了

如果你的渲染器出现了下面这种多光斑/结构性伪影（下图只有一个面光源）：

<img src="\assets\C8_0.png" style="zoom:50%;" />

基本可以确定是随机数生成出了问题，存在某个或多个维度出现了混杂，说实话很难排查具体是哪里的问题，要想彻底解决，需要对每一个需要随机决策的维度都单独做去相关，那个就很复杂了。我也是尝试了很多版，才确定了上面的可用且比较简单的版本

## BRDF
接下来就是计算BRDF了，肯定还是沿用经典的Cook-Torrance，这个在LearnOpenGL中有详细讲解，不详细说了
```glsl
// Cook-Torrance specular BRDF
vec3 fresnelSchlick(float cosTheta, vec3 F0);
float DistributionGGX(vec3 N, vec3 H, float roughness);
float GeometrySchlickGGX(float NdotV, float roughness);
float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness);
```

## 光线采样
光线在每次反弹时发生的事，就需要深刻的理解如何使用蒙特卡洛来计算渲染方程了：

连续版本的**渲染方程（Rendering Equation）** ：

$$
L_o(x, \omega_o) = L_e(x, \omega_o) + \int_{\mathcal{H}^2} f_r(x, \omega_i, \omega_o) \, L_i(x, \omega_i) \, (\omega_i \cdot n) \, d\omega_i
$$


**蒙特卡洛积分**进行估计：

$$
\int_{\mathcal{H}^2} g(\omega) \, d\omega \approx \frac{1}{N} \sum_{i=1}^N \frac{g(\omega_i)}{p(\omega_i)}
$$

应用到渲染方程中（记 $g(\omega_i) = f_r \cdot L_i \cdot \cos\theta$），得到路径追踪中对 $L_o$ 的估计形式：

$$
L_o(x, \omega_o) \approx L_e(x, \omega_o) + \frac{1}{N} \sum_{i=1}^N \frac{f_r(x, \omega_i, \omega_o) \cdot L_i(x, \omega_i) \cdot (\omega_i \cdot n)}{p(\omega_i)}
$$


* $p(\omega_i)$：在单位半球上采样方向 $\omega_i$ 的概率密度函数（PDF）


先忽略发光项，因为路径追踪是原本渲染方程所定义的一个反向过程，考虑第一次反弹，可以将$\omega_o$想象为从摄像机发出的光线，$\omega_i$是采样的一条光线，即选一个$g(\omega)$ , 采样出反弹方向。随后计算出这一部分：
$$
\frac{f_r(x, \omega_i, \omega_o) \cdot (\omega_i \cdot n)}{p(\omega_i)}
$$
将原来的光线强度（刚出发时定义为1.0），乘以这个计算出的部分，就可以看作是反弹后的光线携带的能量$L_i(x, \omega_i)$，直到这个光线打到光源，我们才结算其对于第一个交点的贡献度。当然这个是一个直观的解释，要更严谨的理解整个过程，需要写出渲染方程的递归展开形式，这里就不展开了

对于$g(\omega)$的选择，这里定义三个函数：
```glsl
// 光线采样相关
vec3 uniformSampleHemisphere(vec2 Xi, vec3 N);  // 半球均匀采样
vec3 cosineSampleHemisphere(vec2 Xi, vec3 N);   // 余弦加权采样
vec3 ImportanceSampleGGX(vec2 Xi, vec3 N, float roughness); // GGX重要性采样
```
一开始就用半球均匀采样进行测试。所谓重要性采样，就是选择：在具有更高贡献度的光线可能的方向，对应有更高概率分布的$g(\omega)$，这么来看，余弦加权采样也是比较朴素的一种重要性采样，垂直于物体表面的光线有更高的贡献度，那就在垂直方向多采样即可。注意不同$g(\omega)$不会影响结果的均值，只会影响方差，表现为收敛速度

## 路径追踪
首先在主函数开头：
```glsl
void main() {
    uvec2 pixelCoord = gl_GlobalInvocationID.xy; // 当前像素坐标
    ivec2 imageSize = imageSize(resultImage);
    if (pixelCoord.x >= imageSize.x || pixelCoord.y >= imageSize.y)
        return;

    RNGState rng = rng_init( pixelCoord, frameIndex, 0u );  // 初始化随机数生成器

    const int MAX_BOUNCES = 8;
    const int SAMPLES_PER_PIXEL = 16;
    const float RUSSIAN_ROULETTE_PROB = 0.8;

    int tlasRoot = int(tlasNodes.length()) - 1;

    vec3 accumulateColor = vec3(0.0);

    for (uint samples = 0; samples < SAMPLES_PER_PIXEL; ++samples) {
        // ...
    }
}
```
一些准备工作，用pixelCoord和frameIndex初始化了随机数生成器，这里先忽略了第三个参数，其实直接删了也行。然后是每个像素：
```glsl
for (uint samples = 0; samples < SAMPLES_PER_PIXEL; ++samples) {
    // Optional: 不同 sample 用一次跳跃 (‘leapfrog’) 防止序列重叠
    rng.state += 0x9e3779b9u;
    // 生成 ray
    vec2 subPixel  = vec2(rng_nextFloat(rng), rng_nextFloat(rng)); // tent filter 更好
    vec2 ndc = ((vec2(pixelCoord) + subPixel) / vec2(imageSize)) * 2.0 - 1.0;
    vec4 rayClip = vec4(ndc, -1.0, 1.0);
    vec4 rayView = inverse(viewProjectionMatrix) * rayClip;
    rayView /= rayView.w;

    vec3 rayOrig = cameraPosition;
    vec3 rayDir = normalize(rayView.xyz - cameraPosition);

    vec3 throughput = vec3(1.0);    // 光线初始强度
    vec3 radiance = vec3(0.0);

    for (uint bounce = 0; bounce < MAX_BOUNCES; ++bounce) {
        // ...
    }
}
```
每次采样生成光线时，添加一个像素内的扰动，可以加速收敛、抗锯齿等

最后对于每次采样：
```glsl
for (uint bounce = 0; bounce < MAX_BOUNCES; ++bounce) {
    // 场景射线追踪--------------------------------------------------------------
    HitInfo hitInfo;
    hitInfo.tWorld = 1e20;
    hitInfo.hit = false;

    traceTLAS_stack(tlasRoot, rayOrig, rayDir, hitInfo);

    // 检测沿此方向的光源--------------------------------------------------------
    bool lit = false;
    vec3  lightColor;
    float lightIntensity;
    float tLight = 1e30;               // 默认“无光源”

    // 面光：返回距离 (tLight) + 颜色 / 强度
    if (hitFaceLight(rayOrig, rayDir, tLight, lightColor, lightIntensity)) {
        if (tLight < hitInfo.tWorld - 1e-4) {   // 最近的是光，不是物体
            if (bounce == 0){
                radiance += throughput * lightColor;      // 首次即命中面光源，直接返回，用于标识灯光位置
                break;
            }
            radiance += throughput * lightColor * lightIntensity;
            lit = true;          // 直接出循环（不再反弹）
        }
    }

    // 方向光 == “无限远平行光”
    // 只要射线方向与方向光方向相同，且前方没有任何几何体挡住，就可直接累加
    if (!lit && hitDirectionalLight(rayDir, lightColor, lightIntensity)) {
        if (!hitInfo.hit && bounce > 0) {      // 没有物体挡住 → 可见
            radiance += throughput * lightColor * lightIntensity;
            lit = true;
        }
    }

    if (lit) break;              // 本路径在此方向已“见光”，结束本 bounce
    if (!hitInfo.hit) break;

    // 获取材质-----------------------------------------------------------
    Material mat = materials[hitInfo.materialID];
    vec3 N = normalize(hitInfo.normal);
    vec3 V = -rayDir;
    vec3 albedo = mat.baseColor;
    float metallic = mat.metallic;
    float roughness = mat.roughness;

    // 光线采样、BRDF计算------------------------------------------------------------
    vec2 Xi = sobol2D(samples, bounce, rng.state);  // 生成二维随机向量
    vec3 L = uniformSampleHemisphere(Xi, N); // 半球均匀采样 L
    vec3 H = normalize(V + L); // 反射向量 H
            

    float NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) break;

    // Fresnel 基础反射率
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    vec3 F  = fresnelSchlick(max(dot(H, V), 0.0), F0);

    // Cook-Torrance BRDF
    float NDF = DistributionGGX(N, H, roughness);       
    float G   = GeometrySmith(N, V, L, roughness); 
    vec3 nominator    = NDF * G * F;
    float denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.001; 
    vec3 specular     = nominator / denominator;  
    vec3 diffuse = albedo / PI;

    vec3 kS = F;
    vec3 kD = vec3(1.0) - kS;
    kD *= 1.0 - metallic;   

    vec3 brdf = kD * diffuse + specular;

    // 更新路径贡献
    float pdf = 1.0 / (2.0 * PI);   // 均匀半球采样 pdf
    pdf = max(pdf, 1e-4);
    throughput *= brdf * NdotL / pdf;

    // 光线更新
    rayOrig = hitInfo.hitPos + N * 1e-4;    // 防止自交
    rayDir = L;

    // 其他更新-----------------------------------------------------
    // Russian Roulette（从第三跳开始）
    if (bounce > 2) {
        float p = max(throughput.r, max(throughput.g, throughput.b));
        if (rng_nextFloat(rng) > p) break;
        throughput /= p;
    }

    // 更新 rng 的“反弹维度”信息 (可选)
    rng.state += uint( bounce * 0x632be59bu );   // decorrelate per bounce
}
```
应该比较清晰，一个基础的路径追踪比较简单，难点都在上面封装好的函数里面，主循环里基本没有很难理解的地方

## 构建
手动创建一个经典的盒子场景，效果还是不错的。但帧数骤降至3到4帧，均匀采样收敛速度很慢，积累大概100帧才勉强可以看，后续细微的噪点也很难消除，这和帧间积累的算法也有关系。下一节中我们会大幅改进这一点

<img src="\assets\C8_1.png" style="zoom:50%;" />

## 代码存档
::: tip 代码下载
[点击下载本章的代码存档](/downloads/code8.zip)
:::