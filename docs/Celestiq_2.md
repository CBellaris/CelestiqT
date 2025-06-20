# 添加基础功能

## Buffer Object
缓冲对象在vulkan中算是个大话题，这里先简单总结一下

### 顶点数据
在话题切入到Buffer Object之前，先看看其能用在哪。以顶点数据，也就是vertex buffer为例，这里基本可以类比OpenGL中的VBO+VBOLayout = VAO, 绘制：glBindVertexArray(VAO)，不同的是，vulkan将VAO放在了Pipeline中，对应关系大概是：

| OpenGL              | Vulkan                               | 解释                   |
|:-------------------|:-------------------------------------|:-----------------------|
| VBO (缓冲区)         | `VkBuffer` (vertex buffer)           | 存储顶点数据的缓冲区 |
| VAO (顶点数组对象)  | `VkPipelineVertexInputStateCreateInfo` | 记录顶点数据格式和布局 |
| VBO Layout          | `VkVertexInputBindingDescription` + `VkVertexInputAttributeDescription` | 分别描述绑定和每个属性 |
| glDraw              | `vkCmdBindVertexBuffers` + `vkCmdDraw` | 绑定缓冲区然后绘制 |

那么我们从顶层到底层，先定义一个简单的顶点数据：
```cpp
struct Vertexdata
{
    glm::vec3 Position;
    glm::vec3 Normal;
};
```
首先需要 **VkVertexInputBindingDescription**（绑定描述），这里具体参数目前其实不需要了解，默认参数即是在OpenGL中最常用的状态：
```cpp
VkVertexInputBindingDescription bindingDescription{};
bindingDescription.binding = 0; // 绑定编号
bindingDescription.stride = sizeof(Vertexdata); // 每个顶点步进 52字节
bindingDescription.inputRate = VK_VERTEX_INPUT_RATE_VERTEX; // 每个顶点一次
```
这里的binding和着色器里的binding修饰符没有任何关系，默认置0即可，inputRate是给实例化渲染用的，和OpenGL中调用drawInstance不同，vulkan通过在这里逐实例传入顶点数据，直接统一调用draw函数来绘制

然后是 **VkVertexInputAttributeDescription**（属性描述）
```cpp
std::array<VkVertexInputAttributeDescription, 2> attributeDescriptions{};

attributeDescriptions[0].binding = 0; // 都是绑定0
attributeDescriptions[0].location = 0; // 着色器 location 0
attributeDescriptions[0].format = VK_FORMAT_R32G32B32_SFLOAT; // vec3
attributeDescriptions[0].offset = offsetof(Vertexdata, Position);

attributeDescriptions[1].binding = 0;
attributeDescriptions[1].location = 1; // 着色器 location 1
attributeDescriptions[1].format = VK_FORMAT_R32G32B32_SFLOAT;
attributeDescriptions[1].offset = offsetof(Vertexdata, Normal);
```
对应着色器中：
```
layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
```
然后是 **VkPipelineVertexInputStateCreateInfo**（整体顶点输入描述），把上面的 binding 和 attribute 描述放到 pipeline 里：
```cpp
VkPipelineVertexInputStateCreateInfo vertexInputInfo{};
vertexInputInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;
vertexInputInfo.vertexBindingDescriptionCount = 1;
vertexInputInfo.pVertexBindingDescriptions = &bindingDescription;
vertexInputInfo.vertexAttributeDescriptionCount = static_cast<uint32_t>(attributeDescriptions.size());
vertexInputInfo.pVertexAttributeDescriptions = attributeDescriptions.data();
```
最后在绘制时绑定：
```cpp
vkCmdBindVertexBuffers(commandBuffer, 0, 1, &vertexBuffer, offsets);
vkCmdDraw(commandBuffer, vertexCount, 1, 0, 0);
```
我们目前还没创建vertexBuffer，但已经可以看到，与OpenGL将VBO和VBOLayout统一放在VAO中不同，vulkan这边VBO和其Layout描述其实分开了

### Vertex Buffer
然后来创建一个VBO将数据真正传入显卡，先来一个基础版，步骤大概是：
1. 创建 VkBuffer
2. 获取显存需求
3. 分配显存
4. 绑定显存
5. 把数据复制进去

这里我们分配显存时，选择VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT，也就是cpu能直接访问和读写，对应代码比较多，就不写出来了，使用./App/VKBase.h中封装好的类的话大概是这样：
```cpp
std::vector<Vertexdata> vertices = {
    Vertexdata(1.0f, 1.0f, 0.0f,   0.0f, 0.0f, 1.0f),
    Vertexdata(-1.0f, 1.0f, 0.0f,  0.0f, 0.0f, 1.0f),
    Vertexdata(0.0f, -1.0f, 0.0f,  0.0f, 0.0f, 1.0f)
};

bufferMemory vertexBuffer;

// 1. 定义创建 VkBuffer 的参数
VkBufferCreateInfo bufferCreateInfo = {};
bufferCreateInfo.size = sizeof(Vertexdata) * vertices.size();
bufferCreateInfo.usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT;
bufferCreateInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

// 2. 创建 buffer + 分配 memory + 绑定 memory
if (VkResult result = vertexBuffer.Create(bufferCreateInfo, 
    VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)) {
    throw std::runtime_error("Failed to create CPU-writable vertex buffer!");
}

// 3. 上传顶点数据
if (VkResult result = vertexBuffer.BufferData(vertices.data(), bufferCreateInfo.size)) {
    throw std::runtime_error("Failed to upload vertex data to vertex buffer!");
}
```
### Staging Buffer
但像上面一样可以直接写入GPU显存，并不是最理想的状态，最理想的是把顶点数据放在 GPU 的「DeviceLocal」高速内存里，这样绘制速度最快。但「DeviceLocal」内存CPU无法直接写入，所以要先用「Staging Buffer」在CPU上准备数据，再复制（拷贝）到DeviceLocal的Buffer中。这里的Staging Buffer类似于上面一样创建的内存，其实就是多了一个将这块内存再复制到GPU高速显存的步骤

因此，现在的步骤变成了：
1. 创建一个 Staging Buffer

- `VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | - VK_MEMORY_PROPERTY_HOST_COHERENT_BIT`

- `VK_BUFFER_USAGE_TRANSFER_SRC_BIT`

2. 创建一个 DeviceLocal Buffer

- `VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT`

- `VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_VERTEX_BUFFER_BIT`

3. 把数据拷贝到 Staging Buffer

- 用 `BufferData`

4. 用命令缓冲区 (vkCmdCopyBuffer)

- 把 Staging Buffer 拷贝到 DeviceLocal Buffer

5. 完成以后，Staging Buffer可以销毁

代码如下（仅供理解）：
```cpp
// 1. 创建staging buffer
bufferMemory stagingBuffer;

VkBufferCreateInfo stagingCreateInfo{ VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
stagingCreateInfo.size = sizeof(Vertexdata) * vertices.size();
stagingCreateInfo.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
stagingCreateInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

if (VkResult result = stagingBuffer.Create(
    stagingCreateInfo,
    VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT
)) {
    throw std::runtime_error("Failed to create staging buffer!");
}
// 上传数据到 staging buffer
if (VkResult result = stagingBuffer.BufferData(vertices.data(), stagingCreateInfo.size)) {
    throw std::runtime_error("Failed to upload vertex data to staging buffer!");
}

// 2. 创建 DeviceLocal VertexBuffer
bufferMemory deviceLocalVertexBuffer;

VkBufferCreateInfo deviceBufferCreateInfo{ VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
deviceBufferCreateInfo.size = stagingCreateInfo.size;
deviceBufferCreateInfo.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_VERTEX_BUFFER_BIT;
deviceBufferCreateInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

if (VkResult result = deviceLocalVertexBuffer.Create(
    deviceBufferCreateInfo,
    VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT
)) {
    throw std::runtime_error("Failed to create device local vertex buffer!");
}

// 3. 用命令缓冲区拷贝数据
VkCommandBuffer commandBuffer = BeginSingleTimeCommands(); // 实际没这个函数，就是绑定单次命令缓冲区
VkBufferCopy copyRegion{};
copyRegion.srcOffset = 0;
copyRegion.dstOffset = 0;
copyRegion.size = stagingCreateInfo.size;
vkCmdCopyBuffer(commandBuffer, stagingBuffer.Buffer(), deviceLocalVertexBuffer.Buffer(), 1, &copyRegion);
EndSingleTimeCommands(commandBuffer); // 提交并等待完成
```

./App/VKBase.h中额外添加stagingBuffer、deviceLocalBuffer和vertexBuffer等封装，只需要创建vertexBuffer，调用`TransferData()`就可以自动完成上面的步骤。indexBuffer, uniformBuffer, storageBuffer等相似，这里不再赘述

### 内存布局
创建BufferObject还有一个需要注意的地方，就是内存布局，这里进行总结：

| 特性 | std140 | std430 |
|:----|:------|:------|
| 主要用途 | Uniform Buffer Object (UBO) 默认布局 | Shader Storage Buffer Object (SSBO) 常用布局 |
| 对齐规则 | 严格对齐（常有填充） | 更紧凑，只对数组元素和结构体成员要求 |
| 跨平台兼容性 | 极好，适合 UBO | 需要支持 SSBO 的平台，现代GPU普遍支持 |
| 典型场景 | 相机矩阵、光照参数、材质常量 | 大量实例数据、粒子系统数据 |


| 数据类型 | std140对齐 | std430对齐 | 备注 |
|:---------|:-----------|:-----------|:-----|
| `float`, `int`, `bool` | 4字节 | 4字节 | 相同 |
| `vec2` | 8字节 | 8字节 | 相同 |
| `vec3`, `vec4` | 16字节 | 16字节 | 相同 |
| `数组元素` | 16字节 | 自然对齐 | std430不强制vec4对齐 |
| `结构体` | 结构体成员最大对齐 | 成员自然对齐 | std140有额外padding |

当然这样还不太好理解，举几个例子，
假设我们要传输以下数据：
```cpp
struct Example {
    glm::vec3 position;  // 12 bytes
    float intensity;     // 4 bytes
    glm::vec2 uv;        // 8 bytes
    float temperature;   // 4 bytes
};
```
glsl中都是这样的：
```
layout(std430, binding = 0) buffer ExampleBlock {
    vec3 position;
    float intensity;
    vec2 uv;
    float temperature;
};
```
**std140**:
```cpp
// c++代码端
struct alignas(16) ExampleStd140 {
    glm::vec3 position;   // 12 bytes + 4 bytes padding
    float intensity;      // 4 bytes
    float padding1[3];     // 12 bytes padding to align next vec2
    glm::vec2 uv;         // 8 bytes + 8 bytes padding
    float temperature;    // 4 bytes
    float padding2[3];     // 12 bytes padding to make struct size multiple of 16
};
```
**std430**:
```cpp
// c++代码端
struct ExampleStd430 {
    glm::vec3 position;   // 12 bytes
    float intensity;      // 4 bytes
    glm::vec2 uv;         // 8 bytes
    float temperature;    // 4 bytes
};
```
这里只是举例，实际应用时，意思就是对于std140，vec3一定是会填充的，而std430你可以把一个float等4字节的类型接在vec3后节省空间。std140的结构体，必须要填充到16字节倍数，std430则不用

但如果想创建结构体的数组，则std140和std430都是要把结构体填充到16倍数的，举例：
```cpp
// c++代码端
struct LightUnit {
    alignas(16) glm::vec3 position = glm::vec3(0.0f, 0.0f, 0.0f);  
    alignas(16) glm::vec3 direction = glm::vec3(0.0f, -1.0f, 0.0f);
    alignas(16) glm::vec3 color = glm::vec3(1.0f, 1.0f, 1.0f);     
    alignas(16) glm::vec3 intensity = glm::vec3(0.2f, 0.5f, 0.5f); 

    alignas(4) float constant = 1.0f;
    alignas(4) float linear = 	0.14f;
    alignas(4) float quadratic = 0.07f;

    alignas(4) int visibility = 1;
    alignas(4) int isDirectional = 0;

    alignas(4) float padding1;
    alignas(4) float padding2;
    alignas(4) float padding3;
};
// -------------------------------------------------
// glsl中：
struct Light {
    vec3 position;
    vec3 direction;
    vec3 color;
    vec3 intensity;

    float constant;
    float linear;
    float quadratic;

    int visibility;
    int isDirectional;

    float padding1;
    float padding2;
    float padding3;
};
layout(std430, binding = 1) buffer LightBuffer {
    Light lights[];
};
```
这个结构体的设计同时满足std140和std430的要求，显式使用alignas来提高了可读性，如果只想满足std430，则可以在alignas(12)的vec3后放一个float，而不是alignas(16)，这样可以节省一些空间 **（这样操作好像需要额外设置，不太确定行不行，大部分时候保持上面的设计就行）**

尽量不要用bool，因为bool也会填充至4字节，容易出错，用int替代即可


## Mesh
说了这么多，接下来实际使用一下vertexBuffer和uniformBuffer，首先是vertexBuffer，在./src/Mesh.h中创建Mesh类，定义这样的顶点数据：
```cpp
struct Vertexdata
{
    glm::vec3 Position;
    glm::vec3 Normal;
    glm::vec2 TexCoords;

    glm::vec3 Tangent;   // 切线
    float tangentW;      // 切线方向标志位（+1 或 -1）
};
```
其中大部分代码都是从我之前的项目里复制的，懒得改了，所以这里顶点定义比较复杂，还包括一些创建基本几何体、维护模型矩阵和计算切线的功能代码，可以先忽略，只需要关注vulkan的接口实现即可，这里其实只创建了VertexBuffer，IndexBuffer的部分只是懒得删了，依旧可以先忽略（其实这些都只是为了测试，因为后面实现路径追踪我们不会用这些传入顶点，而是使用SSBO）。创建过程中具体来说就是调用`Mesh::set_mesh()`传入顶点数据，然后调用`Mesh::create_vertex_buffer()`创建VertexBuffer，然后提供一个静态方法`Mesh::bind_pipeline()`来为管线创建时提供相关信息，最后调用`Mesh::draw()`绘制即可

## Camera
然后是uniformBuffer，我们用其传入摄像机相关信息，在./src/Camera.h中创建Camera类，这里的设计应该比较常规，基本上就是维护内外属性，更新摄像机矩阵，响应键盘鼠标等，就不赘述了。其中还维护了一个UBO对象成员cameraUBO，对应着色器中是这样的：
```
layout(binding = 0) uniform Camera {
    mat4 viewProjectionMatrix; // 视图投影矩阵
    vec3 cameraPosition;       // 摄像机位置
};

void main() {
    gl_Position = viewProjectionMatrix * vec4(inPosition, 1.0);
}
```
基本上摄像机需要传入着色器的就这两个，在`setCameraPosition()`和`updataViewProjectionMatrix()`中更新UBO即可。

UBO创建除了uniformBuffer本身，还需要创建描述符集，相关代码在`Renderer::Init()`里，在创建管线前：
```cpp
// 创建管线 ----------------------
// 摄像机
r_camera = std::make_unique<Camera>();
r_descriptorSetLayout_camera = std::make_unique<descriptorSetLayout();
r_descriptorSet_camera = std::make_unique<descriptorSet>();
// descriptorSetLayout
VkDescriptorSetLayoutBinding descriptorSetLayoutBinding_camera = {
    .binding = 0,                                       //描述符被定到0号binding
    .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,//类型uniform缓冲区
    .descriptorCount = 1,                               //个数是1个
    .stageFlags = VK_SHADER_STAGE_VERTEX_BIT            //在顶点着器阶段读取uniform缓冲区
};
VkDescriptorSetLayoutCreateInfodescriptorSetLayoutCreateInfo_camera = {
    .bindingCount = 1,
    .pBindings = &descriptorSetLayoutBinding_camera
};
r_descriptorSetLayout_camera->Creat(descriptorSetLayoutCreateInfo_camera);
// descriptorSet
r_descriptorPool->AllocateSets(makeSpanFromOn(r_descriptorSet_camera.get()), makeSpanFromOn(r_descriptorSetLayout_camera.get()));
VkDescriptorBufferInfo bufferInfo = {
    .buffer = r_camera->getCameraUBO(),
    .offset = 0,
    .range = r_camera->getCameraUBOSize()//或VK_WHOLE_SIZE
};
r_descriptorSet_camera->Write(makeSpanFromOne(bufferInfo),VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER);
// pipelineLayout
VkPipelineLayoutCreateInfo pipelineLayoutCreateInfo = {
    .setLayoutCount = 1,
    .pSetLayouts = r_descriptorSetLayout_camera->Address()
};
r_pipelineLayout = std::make_unique<pipelineLayout(pipelineLayoutCreateInfo);
```
固定的一套流程，然后在绘制前绑定描述符集即可：
```cpp
vkCmdBindDescriptorSets(r_commandBuffer->getHandle(), VK_PIPELINE_BIND_POINT_GRAPHICS,
        r_pipelineLayout->getHandle(), 0, 1, r_descriptorSet_camera->Address(), 0, nullptr);
```
为了管理鼠标键盘，在./App/Input.h中首先定义所有按键的枚举类，这个和glfw中的定义是对应的，然后创建Iuput单例类，提供所有的鼠标和按键检测函数，然后提供`update()`在每帧调用更新，这里先添加了一个逻辑，就是按tab按键切换鼠标锁定，因为我们需要只在鼠标被锁定时，才控制相机的视角，鼠标未锁定时控制UI

注意这里还有按键缓存机制，因为需要区分按键的按下瞬间和按下保持两种不同的操作，所以每帧先调用`pull()`更新所有的按键状态，对比前后帧，上一帧未按下，这一帧按下了，才算是按下瞬间操作。

另外添加按键回调逻辑，目前我们需要注册：
```cpp
// Renderer::Init()
Celestiq::Input::getInstance().registerKeyCallback(Celestiq::KeyCode::Tab, Celestiq::KeyState::Pressed, [this]{r_camera->resetFirstMouse();});
```
用于在切换鼠标锁定时重置摄像机的鼠标位置缓存，否则当鼠标从未锁定切换至锁定时，其坐标会瞬移到屏幕中央，导致视角跳转

## 构建
回到Renderer，先做一个小修改，将commandPool成员移除，这个添加至Application中管理了，因为一些封装类需要用到一些全局的commandBuffer，目前是stagingBuffer中，复制内存要调用命令。还修改了Application中，之前只创建一个队列族的逻辑，创建单独的计算队列族，分配图形和计算两个命令池，为后面的路径追踪提前准备一下

除此之外还更新了一下顶点着色器：
```
#version 450
#pragma shader_stage(vertex)

layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
layout(location = 2) in vec2 inTexCoords;
layout(location = 3) in vec3 inTangent;
layout(location = 4) in float inTangentW;

layout(binding = 0) uniform Camera {
    mat4 viewProjectionMatrix; // 视图投影矩阵
    vec3 cameraPosition;       // 摄像机位置
};

void main() {
    gl_Position = viewProjectionMatrix * vec4(inPosition, 1.0);
}
```
运行程序，按tab切换锁定，可以使用wasd和鼠标围绕观察立方体：

<img src="\assets\C2_0.png" style="zoom:50%;" />
