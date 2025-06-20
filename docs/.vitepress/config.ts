// https://vitepress.vuejs.org/config/app-configs
import { defineConfig } from 'vitepress'

import mathjax3 from 'markdown-it-mathjax3'

const customElements = ['mjx-container'];

// 使用 defineConfig 包裹你的配置，以获得类型提示
export default defineConfig({
  // 网站元数据
  title: 'Celestiq',
  description: 'Ray tracing renderer',

  // 主题配置
  themeConfig: {
    // 网站 Logo
    logo: '/icon.ico',

    // 导航栏
    nav: [
      { text: '首页', link: '/' },
      { text: '关于我', link: '/about' }
    ],

    // 侧边栏
    sidebar: {
      // Vue 教程的侧边栏
      '/': [
        {
          text: '目录',
          items: [
            { text: '1. 搭建项目框架并绘制三角形', link: '/Celestiq_1' },
            { text: '2. 添加基础功能', link: '/Celestiq_2' },
            { text: '3. 延迟渲染', link: '/Celestiq_3' },
            { text: '4. 计算管线', link: '/Celestiq_4' },
            { text: '5. 构建场景', link: '/Celestiq_5' },
            { text: '6. 加速结构', link: '/Celestiq_6' },
            { text: '7. 图像纹理', link: '/Celestiq_7' },
            { text: '8. PBRT', link: '/Celestiq_8' },
            { text: '9. 重要性采样、NEE和MIS', link: '/Celestiq_9' },
            { text: '10. BSDF', link: '/Celestiq_10' },
            { text: '11. RIS和WRS', link: '/Celestiq_11' },
          ]
        }
      ]
    },

    // 社交链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com/your-username' }
    ]
  },
  markdown: {
    config: (md) => {
      md.use(mathjax3);
    },
  },
  vue: {
    template: {
      compilerOptions: {
        isCustomElement: (tag) => customElements.includes(tag),
      },
    },
  },
})