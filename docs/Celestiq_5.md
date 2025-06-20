# 构建场景
将场景信息合并传入计算着色器，是实现路径追踪前需要在cpu端做的最后一件事，整体来讲并不简单，会分成几章来讲

## 总览
先整体看看路径追踪所需的所有场景信息：

```glsl
// 顶点缓存结构体
struct Vertex {
    vec3 position;
    vec3 normal;
    vec2 uv;
};

layout(std430, binding = 0) readonly buffer VertexBuffer {
    Vertex vertices[];
};

layout(std430, binding = 1) readonly buffer IndexBuffer {
    uint indices[];
};
```
顶点信息没什么好说的，在之前的章节中就已经引入了Mesh类，将所有的Mesh拼在一起上传即可

```glsl
struct Material {
    vec3 baseColor;
    float roughness;
    int  albedoTextureIndex;
    // ...
};

layout(std430, binding = 2) readonly buffer MaterialBuffer {
    Material materials[];
};

struct Object {
    uint indexOffset;
    uint indexCount;
    uint materialID;
    mat4 transform;
};

layout(std430, binding = 3) readonly buffer ObjectBuffer {
    Object objects[];
};
```
材质和纹理相关是最麻烦的部分，我们要按”相同材质“、“相同变换”等信息为三角面进行分组，之前的Mesh类已经是这样设计的了，一个Mesh对象，还维护其顶点族的材质和模型变换矩阵。随后在构建场景时，需要遍历所有的Mesh，建立上面的Object结构体，即物体-材质间接索引

```glsl
layout(std140, binding = 4) uniform Camera {
    mat4 viewMatrix;
    mat4 projMatrix;
    vec3 cameraPosition;
    uint frameCount;
};
```
相机信息，用UBO更合适，与前面的设计无异，路径追踪可能需要一些额外信息，而不只是前面的viewProjectionMatrix和cameraPosition，这个后面再看

```glsl
struct PointLight {
    vec3 position;
    float radius;
    vec3 color;
    float intensity;
};

layout(std430, binding = 5) readonly buffer PointLightBuffer {
    PointLight pointLights[];
};
```
光源信息，这里只是举例，路径追踪应该只支持面光源和平行光源，点光很少用，很难且没必要

```glsl
struct BVHNode {
    vec4 boundsMin;  // xyz: AABB min, w: 左子节点索引
    vec4 boundsMax;  // xyz: AABB max, w: 右子节点索引
    int  isLeaf;     // 1表示叶子节点
    int  primitiveOffset;
    int  primitiveCount;
    int  padding;
};

layout(std430, binding = 6) readonly buffer BVHBuffer {
    BVHNode bvhNodes[];
};
```
加速结构，cpu构建后传入，不考虑动态更新

```glsl
layout(binding = 7) uniform sampler2D textures[64];
```
纹理和图像资源，依旧是通过Object索引的方式查询，这个可能最后再弄

```glsl
layout(binding = 8, rgba8) uniform writeonly image2D resultImage;
```
当然别忘了存储结果的图像

上面这些只是举例，后面实际可能会更改

## 搭建材质系统框架
在./src/Material.h添加下面的几个类：
```cpp
struct alignas(16) MaterialData {
    glm::vec3 baseColor = glm::vec3(1.0f);
    int baseColorTexture = -1;  // -1 表示无纹理

    glm::vec3 normal = glm::vec3(0.0f, 0.0f, 1.0f);
    int normalTexture = -1;

    float metallic = 0.0f;
    int metallicTexture = -1;
    
    float roughness = 0.5f;
    int roughnessTexture = -1;
};

// 管理单个MaterialData，先不支持图像纹理功能，创建时拥有唯一id。不提供外部创建方法，由MaterialManager创建
class Material {
    friend class MaterialManager;
};

// 全局的材质管理，单例类，提供单个材质的创建，通过id索引并返回单个材质
class MaterialManager {
private:
    std::vector<Material> m_materials;
    // 禁止外部创建
    MaterialManager() = default;
};
```
具体的实现方法请打开文件查看，应该很清晰，主要设计目标就是兼容物体-材质间接索引的构建，还利用哈希函数提供了创建时的去重功能，图像材质的id功能是预留的，目前还没有相关实现。这样就可以在Mesh中维护一个材质id，构建场景时遍历所有Mesh即可构建物体-材质间接索引。并且可以在任何地方创建材质，例如读取模型时：
```cpp
MaterialData mat{};
mat.baseColor = glm::vec3(1.0f, 0.0f, 0.0f);
mat.roughness = 0.3f;
mat.metallic = 0.0f;

// 第二次创建相同材质会返回相同ID
uint32_t id1 = MaterialManager::get().createMaterial(mat);
uint32_t id2 = MaterialManager::get().createMaterial(mat);
assert(id1 == id2);
```
不用担心重复创建、管理等问题

## 光源
在./src/Light.h添加了光源相关类，支持面光和单向光，和材质的类似，就不详细说了

## Scene
现在就可以开始构建场景了，在./src/Scene.h中创建Scene类，整体结构如下：
```cpp
class Scene{
private:
    std::vector<std::unique_ptr<Mesh>> s_meshes;
    std::vector<sceneObject> s_object;
    std::unique_ptr<Camera> r_camera;

    std::unique_ptr<descriptorSetLayout> s_descriptorSetLayout;
    std::unique_ptr<descriptorSet> s_descriptorSet;

    std::unique_ptr<VertexBufferManager>         s_vertexBufferMgr;
    std::unique_ptr<IndexBufferManager>          s_indexBufferMgr;
    std::unique_ptr<ObjectBufferManager>         s_objectBufferMgr;
    std::unique_ptr<MaterialBufferManager>       s_materialBufferMgr;
    std::unique_ptr<FaceLightBufferManager>      s_faceLightBufferMgr;
    std::unique_ptr<DirectionalLightBufferManager> s_directionalLightBufferMgr;
    

public:
    void initScene();
    void initDescriptor(descriptorPool* pool);
    void writeDescriptor();
    void update(float deltaTime);

    // getter
    inline VkDescriptorSetLayout getDescriptorSetLayout() {return s_descriptorSetLayout->getHandle();}
    VkDescriptorSet getDescriptorSet(){return s_descriptorSet->getHandle();}

private:
    void initBufferManager();
    void uploadSceneToGPU();

public:
    // 工具函数，转换颜色格式
    static glm::vec3 hexToVec3(const std::string& hexStr);
};
```
一点点来解释。首先梳理一下构建流程：
1. 首先需要初始化所有场景中的对象，例如材质和网格等，这里先简单写死在`initScene()`中，后续可以添加从配置文件或场景文件中导入
2. 然后我们需要收集/生成所有的数据，形成连续的内存（例如对于vertex和index，简单的将Mesh类中的对应数据提取，对于Object，遍历所有的网格然后生成，对于材质和灯光，前文对应的类中都有提供BufferData的接口）
3. 创建对应大小的SSBO
4. 将数据写入SSBO
5. 最后就是将SSBO写入描述符集

整体还是比较麻烦的，这里我有考虑过访问者模式，但最后感觉没必要，在小项目里滥用这种设计模式比较难以维护。最后只是设计了如下的结构：
```cpp
// 虚基类
class BindableBuffer {
public:
    virtual void create() = 0;
    virtual void upload() = 0;
    virtual void writeDescriptor(descriptorSet& set, uint32_t binding) = 0;
    virtual ~BindableBuffer() = default;
};

// 对应不同数据结构体
template<typename T>
class TypedBufferManager : public BindableBuffer {
protected:
    std::unique_ptr<storageBuffer> buffer;
    std::vector<T> data;

public:
    virtual std::vector<T> fetch() const = 0;

    void create() override {
        data = fetch();
        if (!data.empty())
            buffer = std::make_unique<storageBuffer>(data.size() * sizeof(T));
    }

    void upload() override {
        if (!data.empty())
            buffer->TransferData(data.data(), data.size() * sizeof(T));
    }

    void writeDescriptor(descriptorSet& set, uint32_t binding) override {
        if (buffer) {
            VkDescriptorBufferInfo info{
                .buffer = buffer->getHandle(), .offset = 0, .range = VK_WHOLE_SIZE
            };
            set.Write(makeSpanFromOne(info), VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, binding);
        }
    }
};
```
这里的`fetch`、`create`、`upload`和`writeDescriptor`对应了上面说的**步骤2到5**，对于每个绑定点上的数据，都再从`TypedBufferManager`派生一类即可，具体实现方法同见./src/Scene.h

有了这些`TypedBufferManager`类，Scene当中的实现就非常简单了，在`initScene()`后紧接着调用`initBufferManager()`和`uploadSceneToGPU()`，完成**步骤2到4**

最后调用`initDescriptor()`和`writeDescriptor()`，创建描述符集和写入描述符集即可，对应**步骤5**

## 构建
由于将摄像机放进Scene中管理了，而且新增了场景相关的描述符集，计算管线的创建流程变成了这样：
```cpp
// 先创建存储图像附件的描述符集布局和描述符集
r_descriptorSetLayout_compute = std::make_unique<descriptorSetLayout>();
r_descriptorSet_compute = std::make_unique<descriptorSet>();
VkDescriptorSetLayoutBinding descriptorSetLayoutBinding_compute[1] ={
    // 存储图像
    {
        .binding = 0,                                       //描述符被绑定到0号binding
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,  //类型为存储图像
        .descriptorCount = 1,                               //个数是1个
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT            //在计算着色器阶段读取存储图像
    }
};
VkDescriptorSetLayoutCreateInfo descriptorSetLayoutCreateInfo_compute = {
    .bindingCount = 1,
    .pBindings = descriptorSetLayoutBinding_compute
};
r_descriptorSetLayout_compute->Create(descriptorSetLayoutCreateInfo_compute);
r_descriptorPool->AllocateSets(makeSpanFromOne(r_descriptorSet_compute.get()), makeSpanFromOne(r_descriptorSetLayout_compute.get()));
// 写入存储图像到描述符集
VkDescriptorImageInfo imageInfo = {
    .imageView = r_computeImage->GetImageView(),
    .imageLayout = VK_IMAGE_LAYOUT_GENERAL
};
r_descriptorSet_compute->Write(makeSpanFromOne(imageInfo), VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 0);


// 将存储图像和场景的描述符集布局合并
VkDescriptorSetLayout layouts[2] = {
    r_scene->getDescriptorSetLayout(),
    r_descriptorSetLayout_compute->getHandle()
};
VkPipelineLayoutCreateInfo pipelineLayoutCreateInfo_compute = {
    .setLayoutCount = 2,
    .pSetLayouts = layouts
};
r_pipelineLayout_compute = std::make_unique<pipelineLayout>(pipelineLayoutCreateInfo_compute);
```
这里r_descriptorSetLayout_compute就只包含了用于写入的图片，然后将两个描述符集合并传入`VkPipelineLayoutCreateInfo`，意味着按照顺序，场景相关的描述符集在set=0，图像在set=1，在着色器中定义时要注意

最后修改计算着色器，测试整个场景。在`Scene::initScene()`中，创建了一个立方体、一个球和一个平面，并分别指定了不同的材质颜色。在着色器中，发出光线，与整个场景遍历求交，返回交点的材质颜色，具体的着色器代码实现很清晰，这里就不贴了

构建可以看到，光线成功索引到了正确的材质颜色，帧数相比光栅化略低，目测60帧（在下一节中会详细对比）。光追管线只要理解了整个场景的构建方法，在着色器中可以随机访问所有场景信息，渲染的具体实现就可以非常清晰
<img src="\assets\C5_0.png" style="zoom:50%;" />