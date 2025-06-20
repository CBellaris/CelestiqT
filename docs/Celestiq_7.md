# 图像纹理
在真正实现路径追踪前的最后一个准备，向着色器传入图像纹理。单独一张图像的传入前面已经接触过了，要高效的绑定场景中所有的图像纹理，情况略有不同
## VK_EXT_descriptor_indexing
其实一个VkImage支持绑定多层layers，可以用这个方法上传多张图像，但限制非常多且繁琐，所以就不提这种方法了，更好的选择是启用设备级拓展：`VK_EXT_descriptor_indexing`，提供了非常多的特性，这里不一一列举，后面具体实现时再看

回到./App/Application.cpp，首先添加一个全局变量：`static VkPhysicalDeviceFeatures2 g_physicalDeviceFeatures;`

然后在创建逻辑设备时`void SetupVulkan()`：
```cpp
// ...
// Create Logical Device (with graphics + compute queue)
{
	// 指定拓展，并检查是否支持 ------------------------------
    const uint32_t device_extension_count = 2;
    const char* device_extensions[] = {
		"VK_KHR_swapchain",
		"VK_EXT_descriptor_indexing" // 新增
	};
    // ...
}
// ...
```
指定额外的拓展，随后检查支持性，这里展示了如何使用`.pNext`链式查询：
```cpp
VkPhysicalDeviceDescriptorIndexingFeaturesEXT indexingFeatures{};
indexingFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_FEATURES_EXT;
indexingFeatures.pNext = nullptr;

// 链接到 g_physicalDeviceFeatures
g_physicalDeviceFeatures.pNext = &indexingFeatures;

// 查询支持性
VkPhysicalDeviceFeatures2 feature2{};
feature2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
feature2.pNext = &indexingFeatures;

vkGetPhysicalDeviceFeatures2(g_PhysicalDevice, &feature2);

// 启用所需功能
indexingFeatures.shaderSampledImageArrayNonUniformIndexing = VK_TRUE;
indexingFeatures.runtimeDescriptorArray = VK_TRUE;
indexingFeatures.descriptorBindingPartiallyBound = VK_TRUE;
indexingFeatures.descriptorBindingVariableDescriptorCount = VK_TRUE;
indexingFeatures.descriptorBindingUpdateUnusedWhilePending = VK_TRUE;
```
在填入设备创建信息时链接设备级拓展：
```cpp
// 设备创建信息
VkDeviceCreateInfo create_info = {};
create_info.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
create_info.queueCreateInfoCount = queue_info_count;
create_info.pQueueCreateInfos = queue_info;
create_info.enabledExtensionCount = device_extension_count;
create_info.ppEnabledExtensionNames = device_extensions;
create_info.pNext = &g_physicalDeviceFeatures;  // 添加拓展
```

## 纹理管理
在./src/Material.h中，添加TextureManager类，再次感谢 https://github.com/EasyVulkan/EasyVulkan.github.io 的封装，处理图像纹理的导入非常麻烦，继续借用`imageOperation`, `texture`和`texture2d`三个类，提供了图像读取、创建和写入的功能，还有格式转换和mipmap生成等目前没用上，具体实现可以去./App/VKBase.h中看看源码或者去看配套的教程

有了图像纹理的封装，剩下的就比较简单，TextureManager类维护一个数组`std::vector<std::unique_ptr<Celestiq::Vulkan::texture2d>> m_textures;`，提供添加图片的接口，创建描述符集就可以了，创建描述符集的过程和之前略有不同，因为用到了扩展：
```cpp
// TextureManager
void initDescriptorSet(Celestiq::Vulkan::descriptorPool* pool) {
    VkDescriptorSetLayoutBinding textureArrayBinding{};
    textureArrayBinding.binding = 0;
    textureArrayBinding.descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;		// 注意这里的描述符类型
    textureArrayBinding.descriptorCount = static_cast<uint32_t>(GlobalSettings::TempSetting::MAX_TEXTURE_COUNT);  // 最大纹理数量，比如 1024
    textureArrayBinding.stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT | VK_SHADER_STAGE_COMPUTE_BIT;
    textureArrayBinding.pImmutableSamplers = nullptr;

    // 额外启用 descriptor indexing flags
    VkDescriptorBindingFlagsEXT bindingFlags = VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT_EXT |
                                               VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT_EXT;
    VkDescriptorSetLayoutBindingFlagsCreateInfoEXT bindingFlagsInfo{
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO_EXT,
        .bindingCount = 1,
        .pBindingFlags = &bindingFlags
    };

    VkDescriptorSetLayoutCreateInfo layoutInfo{};
    layoutInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    layoutInfo.bindingCount = 1;
    layoutInfo.pBindings = &textureArrayBinding;
    layoutInfo.pNext = &bindingFlagsInfo;  // 把扩展信息挂进去
    layoutInfo.flags = VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT_EXT;
    m_descriptorSetLayout = std::make_unique<Celestiq::Vulkan::descriptorSetLayout>(layoutInfo);

	// 分配并写入描述符集
    m_descriptorSet = std::make_unique<Celestiq::Vulkan::descriptorSet>();
    pool->AllocateSets(Celestiq::Vulkan::makeSpanFromOne(m_descriptorSet.get()), makeSpanFromOne(m_descriptorSetLayout.get()));

    std::vector<VkDescriptorImageInfo> imageInfos;
    getDescriptorImageInfos(imageInfos);
    m_descriptorSet->Write(imageInfos, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER);
}
```
在创建计算管线(./src/Renederer.cpp :281)时，额外将这个描述符集添加进去：
```cpp
// 将场景、图像纹理和存储图像的描述符集布局合并
VkDescriptorSetLayout layouts[3] = {
    r_scene->getDescriptorSetLayout(),
    TextureManager::get().getDescriptorSetLayout(),
    r_descriptorSetLayout_compute->getHandle()
};
VkPipelineLayoutCreateInfo pipelineLayoutCreateInfo_compute = {
    .setLayoutCount = 3,
    .pSetLayouts = layouts
};
r_pipelineLayout_compute = std::make_unique<pipelineLayout>(pipelineLayoutCreateInfo_compute);
```
绘制时同样绑定即可

## 构建
*这节忘记留代码存档了，不过这节的内容和下一节没太多冲突，看下一节的就可以*

构建场景时，手动创建几个包含纹理的材质测试一下，类似这样：
```cpp
uint32_t texture_0 = TextureManager::get().loadTexture("resimage_texture/scratchMetal_diffuse.jpg");
MaterialData mat{};
//mat.baseColor = hexToVec3("#df4c68");
mat.baseColorTexture = texture_0; 	// 不为-1代表使用图像纹理
mat.roughness = 0.3f;
mat.metallic = 0.0f;
uint32_t material_0 = MaterialManager::get().createMateria(mat);
```

升级一下计算着色器，首先在开头添加`#extension GL_EXT_nonuniform_qualifier : require`，表示用到了相关扩展，添加纹理绑定：
```glsl
layout(set = 1, binding = 0) uniform sampler2D textures[];
```
随后修改求交算法：
```glsl
void traceTLAS_stack(int rootIndex, vec3 rayOrig, vec3 rayDir, inout HitInfo hitInfo);
void traceBLAS_stack(int rootIndex, vec3 rayOrig, vec3 rayDir, mat4 model, int materialID, int baseIndexOffset, inout HitInfo hitInfo);
```
之前只是简单传入交点颜色，现在传入对于交点，需要拿到的全部信息：
```glsl
struct HitInfo {
    float tWorld;
    vec3 hitPos;
    vec3 normal;
    vec2 texCoord;
    int materialID;
    bool hit;
};
```
将之前的求交算法升级为可以拿到重心坐标的版本：
```glsl
bool intersectTriangleBarycentric(vec3 orig, vec3 dir, vec3 v0, vec3 v1, vec3 v2, out float t, out vec3 baryCoord) {
    const float EPSILON = 0.000001;
    vec3 edge1 = v1 - v0;
    vec3 edge2 = v2 - v0;
    vec3 h = cross(dir, edge2);
    float a = dot(edge1, h);
    if (abs(a) < EPSILON) return false;
    float f = 1.0 / a;
    vec3 s = orig - v0;
    float u = f * dot(s, h);
    if (u < 0.0 || u > 1.0) return false;
    vec3 q = cross(s, edge1);
    float v = f * dot(dir, q);
    if (v < 0.0 || u + v > 1.0) return false;
    t = f * dot(edge2, q);
    if (t < EPSILON) return false;
    baryCoord = vec3(1.0 - u - v, u, v);
    return true;
}
```
在`traceBLAS_stack()`中，求得重心坐标后，用其插值得到交点的纹理坐标、法线等
```glsl
void traceBLAS_stack(int rootIndex, vec3 rayOrig, vec3 rayDir, mat4 model, int materialID, int baseIndexOffset, inout HitInfo hitInfo) {
	// ...

    while (sp > 0) {
		// ...
        if (!intersectAABB(localOrigin, localDir, node.bounds)) continue;

        if (node.right < 0 && node.left < 0) {
            for (int i = 0; i < 3; ++i) {
                int localIndex = node.indices[i];
                if(localIndex == -1) break;
                int idx = baseIndexOffset  + localIndex;
                Vertex v0 = vertices[indices[idx + 0]];
                Vertex v1 = vertices[indices[idx + 1]];
                Vertex v2 = vertices[indices[idx + 2]];

                float t;
                vec3 baryCoord;
                if (intersectTriangleBarycentric(localOrigin, localDir, v0.Position, v1.Position, v2.Position, t, baryCoord)) {
                    // 局部空间交点转为世界空间，计算世界空间下的距离
                    vec3 hitLocal = localOrigin + t * localDir;
                    vec3 hitWorld = vec3(model * vec4(hitLocal, 1.0));
                    float tWorld = length(hitWorld - rayOrig);

                    if (tWorld < hitInfo.tWorld) {
                        hitInfo.tWorld = tWorld;
                        hitInfo.hitPos = hitWorld;
                        hitInfo.materialID = materialID;  
                        hitInfo.hit = true;

                        // 插值法线 & 纹理坐标
                        vec3 n0 = mat3(transpose(inverse(model))) * v0.Normal;
                        vec3 n1 = mat3(transpose(inverse(model))) * v1.Normal;
                        vec3 n2 = mat3(transpose(inverse(model))) * v2.Normal;
                        hitInfo.normal = normalize(n0 * baryCoord.x + n1 * baryCoord.y + n2 * baryCoord.z);

                        vec2 uv = v0.TexCoords * baryCoord.x + v1.TexCoords * baryCoord.y + v2.TexCoords * baryCoord.z;
                        hitInfo.texCoord = uv;
                    }
                }
            }
        } 
		// ...
    }
}
```
最后，主循环里，拿到hit信息后，执行一个简单的逻辑测试图像纹理，直接采样材质的baseColorTexture，由于图像目前默认加载为RGBA8位，需要gamma矫正：
```glsl
// 2. 初始化 hit 信息
HitInfo hitInfo;
hitInfo.tWorld = 1e20;
hitInfo.hit = false;

// 3. 遍历 TLAS 根节点（最后一个）
int tlasRoot = int(tlasNodes.length()) - 1;
traceTLAS_stack(tlasRoot, rayOrig, rayDir, hitInfo);

// 4. 计算最终颜色
vec3 finalColor = vec3(0.0);
if (hitInfo.hit) {
    Material mat = materials[hitInfo.materialID];
    if (mat.baseColorTexture >= 0) {
        finalColor = texture(nonuniformEXT(textures[mat.baseColorTexture]), hitInfo.texCoord).rgb;
        finalColor = pow(finalColor, vec3(1.0/2.2)); // gamma校正
    }else{
        finalColor = mat.baseColor;
    }
}
```

效果如下：

<img src="assets\C7_0.png" style="zoom:50%;" />