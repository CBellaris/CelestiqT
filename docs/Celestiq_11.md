# RIS和WRS
此为ReSTIR-GI(global illumination)的前置章节，先来实现两个前置技术：RIS（Resampled Importance Sampling）和WRS（Weighted Reservoir Sampling），搭配时域重用，构建一个简单的ReSTIR-DI(direct illumination)框架

这几章可能是理论部分讨论的最详细的章节，因为我还没有找到比较系统且易懂的中文教程，就结合自己理解，写一篇详细的

主要参考资料：
1. 首先是一个引用较多的文章： https://agraphicsguynotes.com/posts/understanding_the_math_behind_restir_di/ ，中文翻译：https://zhuanlan.zhihu.com/p/591979133 推荐一看，但很多细节的讨论没有明确实现框架，导致比较模糊甚至引起初学者的误解，特别是关于MIS权重，以及RIS+MIS结合的理论框架不是很详细，如果看的过程中比较迷惑，本文会弥补这一部分
2. https://intro-to-restir.cwyman.org/presentations/2023ReSTIR_Course_Notes.pdf SIGGRAPH课程，应该是最详细的一篇关于ReSTIR的文章，本文大部分内容从此引用

## SIR
首先从样本重要性重采样 SIR 说起，先不用管为什么要用它，直接给出流程，注意此时的目的是从目标分布$\hat{p}(x)$中采样一个点：

1. 选取Proposal PDF $p(x)$，这个记号与前面提到的一致，实际应用也是
2. 从$p(x)$中采样M个候选样本（candidates）
3. 为每个样本计算权重：$权重(x) = \frac{\hat{p}(x)}{p(x)}$
4. 从M个候选样本选择一个样本，每个样本被抽取的概率与其权重成正比

这里的记号比较简略，为了不与后面的符号冲突，能理解就可以

最终选择的样本，**其分布**随着M增大接近$\hat{p}(x)$

> 但不严格是$\hat{p}(x)$，文章[1]中将**其**命名为SIR PDF，并说其未知性导致使用SIR采样出的样本无法计算MIS平衡启发式权重，理论上讲确实是这样，但实际应用中，认为最终选择的样本 其分布就是$\hat{p}(x)$即可，文章[1]中也多次提到了无法使用MIS平衡启发式权重，这个第一次看真的很容易引起误会，我看了很多实现，除非是性能考虑，几乎都会使用平衡启发式权重，这个后面会详细解释

要注意，此时的$\hat{p}(x)$依旧是一个概率分布（归一化），当继续引入RIS权重时，$\hat{p}(x)$才可以是任意函数
## RIS
回顾一下（重要性）蒙特卡洛采样估计器
$$
\int_{} f(x) \, dx \approx \frac{1}{N} \sum_{i=1}^N \frac{f(x_i)}{p(x_i)}
$$

$x_i$从$p(x)$中采样，这里$p(x)$是一个尽量与$f(x)$形状接近的，易采样的概率分布，“概率分布”这一点，意味着归一化，其积分等于1。回顾之前我们选用的$p(x)$，即GGX重要性采样和光源均匀采样（转换积分域后），是符合这一点的。“概率分布”这一限制影响了对$p(x)$的选择范围，当选择更复杂的$p(x)$时，很多时候对其归一化是不可能的

公式中的$\frac{1}{p(x)}$其实就是一个权重，为每个采样分配权重，以保持无偏，那有没有可能扩展最基础的蒙特卡洛采样，使得$p(x)$不必是一个严格的概率分布，再调整这个权重，仍然使得最后的估计无偏呢？RIS提供了这样的方法：

引入分布函数$\hat{p}(x)$，这个不再需要是概率分布，任意函数即可

1. 从Proposal PDF $p(x)$ 中采样M个候选样本（candidates）$(X_1,...,X_M)$
2. 为每个样本计算resampling weights： $w_i = \frac{1}{M}\frac{\hat{p}(X_i)}{p(X_i)}$
3. 从M个候选样本中选择一个$X$，每个样本被抽取的概率与其权重成正比
4. 计算一个用于使估计无偏的权重：$W_X=\frac{1}{\hat{p}(X)}\sum_{j=1}^M{w_j}$

随后此$X$可用于估计器$I_{RIS}=f(X)W_X$：
$$
\int_{} f(x) \, dx \approx \frac{1}{N} \sum_{N
次采样X} f(X)W_X
$$

> 最好不要将其理解为从M个候选样本中有放回的选择N个样本，而是每次只选择一个样本，而记号N目前还是依旧可以理解为之前的每个像素多次执行采样，且随时间积累，即代码中的 frameIndex * SAMPLES_PER_PIXEL 比较符合我们现在的实际做法

结合实际来说明一下目前的记号，便于理解：

$f(x)$当然还是渲染方程中需要积分的项，之前写为$f(x)=f_s \cdot L_i \cdot \cos\theta$，还有一套更通用的记号：$f(x)=f_s(x)L(x)G(x)V(x)$，$f_s$依旧是BSDF项，$G$目前就是$\cos\theta$，$V$为可见项，之前其实都隐含在实际操作里了，NEE中，光线被物体挡住时，直接返回，相当于$V$等于0，这个当然值得优化，所以显式写出来是更好的

Proposal PDF $p(x)$，实际使用中依旧是之前的GGX重要性采样或光源采样函数

关键是$\hat{p}(x)$，这是一个新的函数，在估计器中取代了之前$p(x)$的位置，其不用是一个概率分布了，而且依旧需要形状与$f(x)$相似，那当然$\hat{p}(x)=f(x)$是可以的，实际使用中，可以先这么做来验证算法，然后可以选择一个计算更优的$\hat{p}(x)$。例如：回忆上一章BSDF中的透射项，我留了一个简化近似版，令$\hat{p}(x)$等于某个简化近似版的BSDF就是一个选择

此时单个RIS算法并不能从多个不同的Proposal PDF中采样，为此需要引入MIS来扩展RIS算法

## RIS+MIS
有两种方法可以结合RIS+MIS，这两种方法不结合实际来说明真的挺难理解的：目前我们渲染器的框架：一次NEE采样+一次BSDF重要性采样（混合），其中的光源均匀分布即为Proposal PDF $p_1(x)$，BSDF重要性采样即为$p_2(x)$，目前已经用了MIS权重来混合这两根光线，尝试引入RIS算法

**第一种**方法（**先两次RIS，再MIS混合**），我们无需扩展RIS算法本身，而是使用两个独立的RIS算法，目前两个RIS的$\hat{p}(x)$相同（$\hat{p}_1(x)=\hat{p}_2(x)$），都假设为$f(x)$即可。即从 $p_1(x)$采样M个候选，根据权重选一个出来，记为$X_1$，$p_2(x)$同理，选一个$X_2$

使用RIS估计器，计算出两个值：$f(X_1)W_{X_1}$, $f(X_2)W_{X_2}$ 现在需要用MIS权重将其混合，回忆一下MIS算法（balance heuristic），例如$f(X_1)W_{X_1}$，我们需要将其乘以：
$$
weight_{mis}=\frac{X_1的概率}{X_1的概率+X_2的概率}
$$
就遇到上文SIR中提到的问题了，$X_1$和$X_2$的分布严格来讲不知道，其只是接近$\hat{p}(x)$，但不等于，理论上就无法使用balance heuristic了，使用平衡权重，在这里也就是1/2即可

> 真的无法使用balance heuristic了吗？其实还是可以的，使用generalized balance heuristic即可（详见文章[2](eq 3.11)），形式上就是将$X_1$和$X_2$的分布视作$\hat{p}_1(x)$和$\hat{p}_2(x)$即可，实际上还需要一个采样数的加权，文中的版本省略了，也不太需要追究，主要是这generalized balance heuristic不主要用于现在的讨论情况，后面引入时空重用后才会详细讨论这个，只是举个例子。总之，当$\hat{p}_1(x)=\hat{p}_2(x)$，且两边的采样数相同时，balance heuristic会退化至平衡权重，这也是我想说的，balance heuristic不会因为一些原因不可用，只是可能等价于平衡权重而已，除非真的连$\hat{p}(x)$都不知道

**第二种**方法（**先MIS混合采样，再一次RIS**），就是将MIS权重融合进RIS的权重里，为此需要扩展RIS算法，为了记号简单，沿用上面的$p_1(x), p_2(x)$：

1. 从$p_1(x)$ 中采样$M_1$个候选样本$(X_1,...,X_{M_1})$，从$p_2(x)$ 中采样$M_2$个候选样本$(X_{M_1+1},...,X_{M_1+M_2})$
2. 为每个样本计算MIS weights：
$m(X_i)^{(k)} = \frac{p_k(X_i)}{\sum_k^2{M_kp_k(X_i)}}$, $X_i\sim p_k$， 例如从$p_1(x)$ 中采样的样本$X_i$， $m(X_i) = \frac{p_1(X_i)}{M_1p_1(X_i)+M_2p_2(X_i)}$
1. 为每个样本计算resampling weights： $w_i^{(k)} = m(X_i)\frac{\hat{p}(X_i)}{p_k(X_i)}$, $X_i\sim p_k$， 例如从$p_1(x)$ 中采样的样本$X_i$，$w_i = m(X_i)\frac{\hat{p}(X_i)}{p_1(X_i)}$
2. 从所有候选样本中选择一个$X$，每个样本被抽取的概率与其权重成正比
3. 计算一个用于使估计无偏的权重：$W_X=\frac{1}{\hat{p}(X)}\sum_{j=1}^{M_1+M_2}{w_j}$

$I_{RIS}$不变，这样，我们最终相当于只采样了一根光线，但这一根包含了两个采样的信息。就目前的讨论框架（在单次循环中混合两种采样），只考虑第二种方法就ok了

## WRS与时空重用
WRS原理在各个教程中解释的都比较清楚了，这里只贴一下算法：

<img src="assets\C11_0.png" style="zoom:50%;"/>

这里的$generate X_i$就是从分布$p(x)$采样，下一行中的$W_{X_i}$即$\frac{1}{p(x)}$。比起最简单的WRS，还多了一个Confidence weight，核心思路就是在重用时，为更“可靠”的被重用像素分配更高的权重，可以先忽略。先来举个例子先说明如何进行“重用”

以时间重用为例，考虑前后两帧渲染的同一像素，假设摄像机和场景完全不变。在第一帧中，对此像素执行`Resample(M)`，并将返回的Reservoir存在一个buffer中，第二帧，拿到这个Reservoir，记为$r_{prev}$，随后同样执行`Resample(M)`，得到$r_{current}$，随后：$r_{current}.update(r_{prev}.Y, r_{prev}.w_{sum}, r_{prev}.c)$，这就重用了上一帧的Reservoir
- 若摄像机改移动，尝试用运动向量匹配前后像素的Reservoir
- 若摄像机移动/场景变化，重新计算$r_{prev}.w_{sum}$

上面是一个过分简化后的情形，现在一步步来扩展

> **WIP** *鸽置中*

## Reference
[1] https://agraphicsguynotes.com/posts/understanding_the_math_behind_restir_di/

[2] https://intro-to-restir.cwyman.org/presentations/2023ReSTIR_Course_Notes.pdf




