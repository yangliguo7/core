// This entry exports the runtime only, and is built as
// `dist/vue.esm-bundler.js` which is used by default for bundlers.
import { initDev } from './dev'
import { warn } from '@vue/runtime-dom'

// 只有 runtime 版本
// runtime版本，借助vue-loader。将.vue文件 template转换成render函数 (vue cli创建的项目也是这样)
// 使用webpack打包的时候，将代码进行转换

if (__DEV__) {
  initDev()
}

export * from '@vue/runtime-dom'

export const compile = () => {
  if (__DEV__) {
    warn(
      `Runtime compilation is not supported in this build of Vue.` +
        (__ESM_BUNDLER__
          ? ` Configure your bundler to alias "vue" to "vue/dist/vue.esm-bundler.js".`
          : __ESM_BROWSER__
          ? ` Use "vue.esm-browser.js" instead.`
          : __GLOBAL__
          ? ` Use "vue.global.js" instead.`
          : ``) /* should not happen */
    )
  }
}
