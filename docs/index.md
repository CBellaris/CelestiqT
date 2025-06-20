# 项目介绍
基于vulkan的光线追踪渲染器（C++/glsl），附带较详细教程，手搓了非常多软光追的实现细节，这里“软”指未启用硬件级光线追踪拓展，不是指在cpu中运算

教程内容包括：

1. 基于glfw+ImGui的窗口管理框架，vulkan基础对象创建，渲染流程搭建，绘制三角形
2. 缓冲对象详解，构建网格、摄像机系统
3. 延迟渲染，多RenderPass与子通道依赖
4. 计算管线、存储图像和管线屏障
5. 场景信息构建（顶点、索引、材质、灯光），用SSBO传入场景
6. 基于BLAS/TLAS的BVH加速结构，实例化支持
7. VK_EXT_descriptor_indexing扩展和图像纹理管理
8. PBRT路径追踪
9. 重要性采样、NEE和MIS
10. 透射BSDF，天空盒，模型导入等
11. RIS、WSR和ReSTIR-DI

前半部分基本上是vulkan相关和cpu端的数据准备，后半则是路径追踪相关

教程持续更新，未来可能添加有关硬件光追扩展的相关内容

## 使用指南
由于是个人项目，能力和时间都有限，教程方面无法做到非常详细，因此必须配合源代码一起阅读，可以选择直接看最终的项目代码，或者每一节都有对应的代码存档，一步步的构建并添加你自己的想法也是可以的

另外如果没有任何图形API和图形学的基础，那这个教程可能不太适合，我个人建议，虽然现在Vulkan是主流，但直接作为第一个图形API学习是比较吃力的，先简单学一下OpenGL和一些图形学理论基础，再转Vulkan学习曲线会更平滑。这个热身步骤也比较轻松，看[LearnOpenGL CN], https://learnopengl-cn.github.io/ 就可以了

## 效果预览
经典盒子场景：

<img src="assets\C0_0.png" style="zoom:50%;" />

PBR材质：

<img src="assets\C0_1.png" style="zoom:50%;" />

Sponza Palace：

<img src="assets\C0_2.png" style="zoom:50%;" />

<img src="assets\C0_3.png" style="zoom:50%;" />

不同软硬的太阳光：

<img src="assets\C0_4.png" style="zoom:50%;" />

<img src="assets\C0_5.png" style="zoom:50%;" />

磨砂玻璃：

<img src="assets\C0_6.png" style="zoom:50%;" />

<img src="assets\C0_7.png" style="zoom:50%;" />

