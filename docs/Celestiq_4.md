# 计算管线
前面的准备过后，应该足够开始实现一个最简单的软路径追踪了（应该），vulkan的API使用其实还有很多细节可以帮助优化性能，但开发能力有限，目前还是专注主线

需要先理解路径追踪的原理，并且有一个整体的概念，这个不属于本教程范畴，我个人感觉，只要学过一遍LearnOpenGL，深刻理解渲染方程，然后看看Games101 https://www.bilibili.com/video/BV1X7411F744 里的Ray-Tracing章节，基本就OK了，最后的算法就一张图：
<img src="\assets\C4_0.png" style="zoom:50%;" />


## 总览
后面的两章还没有开始实现路径追踪的核心算法，而是在应用端继续做一些准备，具体包括：
1. 光线追踪依赖整个场景的信息，所以vertexBuffer等不再适用，通过SSBO将结构化的场景信息传入
2. 将G-buffer阶段替换为计算管线，将场景渲染至图像。当然光线追踪和延迟渲染本身并不冲突，我们其实可以保留G-buffer阶段，依旧在光照阶段实现一些屏幕空间效果，例如SSAO，光线追踪虽然理论上是正确的结果，但在采样较少时，依旧会缺失邻域遮蔽区的信息，用SSAO来弥补就是很好的选择。但现在就直接替换掉G-buffer阶段
3. 光照Pass基本不变，采样计算管线绘制的图像，显示即可

## 计算管线
首先将G-buffer相关的东西都删除，替换为计算管线，计算管线不依赖renderPass和frameBuffer，只需要相应的可写入纹理（VK_IMAGE_USAGE_STORAGE_BIT）和描述符集（Image、SSBO、UBO）就可以了

计算管线需要一个可以写入的图片，这个图片不再与帧缓冲绑定，而是通过描述符集添加至管线当中。添加一个renderableImageAttachment对象，注意创建时附加上VK_IMAGE_USAGE_STORAGE_BIT用途即可：
```cpp
std::unique_ptr<renderableImageAttachment> r_computeImage;
```
接着我们需要将其添加至计算管线的描述符集布局当中
```cpp
VkDescriptorSetLayoutBinding descriptorSetLayoutBinding_compute[2] ={
    // 摄像机
    {
        .binding = 0,                                       //描述符被绑定到0号binding
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,//类型为uniform缓冲区
        .descriptorCount = 1,                               //个数是1个
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT            //在计算着色器阶段读取uniform缓冲区
    },
    // 存储图像
    {
        .binding = 1,                                       //描述符被绑定到1号binding
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,  //类型为存储图像
        .descriptorCount = 1,                               //个数是1个
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT            //在计算着色器阶段读取存储图像
    }
};
```
然后将其写入计算管线使用的描述符集，注意这里图像Layout是VK_IMAGE_LAYOUT_GENERAL，计算着色器写入图像就需要这种layout
```cpp
// 摄像机UBO
VkDescriptorBufferInfo bufferInfo = {
    .buffer = r_camera->getCameraUBO(),
    .offset = 0,
    .range = r_camera->getCameraUBOSize()//或VK_WHOLE_SIZE
};
// 存储图像
VkDescriptorImageInfo imageInfo = {
    .imageView = r_computeImage->GetImageView(),
    .imageLayout = VK_IMAGE_LAYOUT_GENERAL
};
r_descriptorSet_compute->Write(makeSpanFromOne(bufferInfo), VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 0);
r_descriptorSet_compute->Write(makeSpanFromOne(imageInfo), VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1);
```

创建计算管线，跟图像管线类似，但简单许多：
```cpp
// 创建着色器
r_shaders["compute"] = std::make_unique<shaderModule>("res/shader_spv/Deferred_C.comp.spv");
VkPipelineShaderStageCreateInfo shaderStageCreateInfos_compute[1] = {
    r_shaders["compute"]->StageCreateInfo(VK_SHADER_STAGE_COMPUTE_BIT)
};

VkComputePipelineCreateInfo computePipelineCreateInfo = {
    .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
    .stage = shaderStageCreateInfos_compute[0],
    .layout = r_pipelineLayout_compute->getHandle()
};
r_pipeline_compute = std::make_unique<pipeline>(computePipelineCreateInfo);
```

图形部分（光照Pass）对应的有两个修改，将r_computeImage绑定至图像管线的描述符集，然后修改其子通道依赖：
```cpp
VkSubpassDependency dependency{};
dependency.srcSubpass    = VK_SUBPASS_EXTERNAL;
dependency.dstSubpass    = 0;
dependency.srcStageMask  = VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
dependency.dstStageMask  = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
dependency.srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT;
dependency.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
```
因为现在只有一个renderPass了，所以这是一个最保守的依赖设置，基本上没有实际同步了什么

## 着色器
创建./res/shader_glsl/Deferred_C.comp.shader：
```
#version 450
#pragma shader_stage(compute)

layout(local_size_x = 16, local_size_y = 16) in;

// binding = 0: camera
layout(binding = 0) uniform Camera {
    mat4 viewProjectionMatrix; // 视图投影矩阵
    vec3 cameraPosition;       // 摄像机位置
};
// binding = 1: output image (储存最终颜色)
layout(binding = 1, rgba8) uniform writeonly image2D resultImage;

void main() {
    uvec2 pixelCoord = gl_GlobalInvocationID.xy;

    ivec2 imageSize = imageSize(resultImage);

    if (pixelCoord.x >= imageSize.x || pixelCoord.y >= imageSize.y)
        return;

    // 简单测试颜色：基于像素坐标生成一个红-绿渐变
    vec4 color = vec4(
        float(pixelCoord.x) / float(imageSize.x),
        float(pixelCoord.y) / float(imageSize.y),
        0.0,
        1.0
    );

    imageStore(resultImage, ivec2(pixelCoord), color);
}
```
计算着色器和vkCmdDispatch这里先不仔细讲解了，了解一下基本概念就行，基本上就是对每个像素开启一个线程（这里的main函数就是针对一个线程来执行的），通过各种内建变量来访问该线程的各种信息，例如这里的gl_GlobalInvocationID就是其全局ID，就是屏幕像素坐标。上面的着色器没有做任何事，只是测试图像的写入，根据像素坐标生成一个红-绿渐变

## 同步
最重要的依旧是处理图像的同步问题，创建函数：
```cpp
void transitionImageLayout(VkCommandBuffer cmd, const std::vector<renderableImageAttachment*>& attachments, 
                        VkAccessFlags srcAccessMask, VkAccessFlags dstAccessMask,
                        VkImageLayout oldLayout, VkImageLayout newLayout,
                        VkPipelineStageFlags srcStageMask, VkPipelineStageFlags dstStageMask);
```
这个函数和上一章提到的类似，将一些参数提取出来了而已，我们在指定的阶段，手动切换图像（主要是r_computeImage）的layout，流程如下：

1. 开始命令录入
2. 若r_computeImage第一次创建（第一帧）或被resize，在阶段VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT -> VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT时，将图像从UNDEFINED切换到GENERAL
3. 若r_computeImage并非重新创建，上一个阶段就是光照Pass，则在阶段VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT -> VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT时，将图像从SHADER_READ_ONLY_OPTIMAL切到GENERAL
4. 调用`vkCmdDispatch()`开始计算
5. 计算阶段结束，反向上面的操作，将图像从GENERAL切到SHADER_READ_ONLY_OPTIMAL供光照Pass采样

## 构建
构建程序可以看到，像素被写入了渐变的颜色

<img src="\assets\C4_1.png" style="zoom:50%;" />