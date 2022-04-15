import {
  createRenderer,
  createHydrationRenderer,
  warn,
  RootRenderFunction,
  CreateAppFunction,
  Renderer,
  HydrationRenderer,
  App,
  RootHydrateFunction,
  isRuntimeOnly,
  DeprecationTypes,
  compatUtils
} from '@vue/runtime-core'
import { nodeOps } from './nodeOps'
import { patchProp } from './patchProp'
// Importing from the compiler, will be tree-shaken in prod
import {
  isFunction,
  isString,
  isHTMLTag,
  isSVGTag,
  extend,
  NOOP
} from '@vue/shared'

declare module '@vue/reactivity' {
  export interface RefUnwrapBailTypes {
    // Note: if updating this, also update `types/refBail.d.ts`.
    runtimeDOMBailTypes: Node | Window
  }
}

// rendererOptions => 一个具有生成真实dom方法的对象、 浏览器 dom 环境的具体实现
// extend：对象浅拷贝
// nodeOps：具有对dom操作相关的方法的对象
// patchProp：生成真实dom
const rendererOptions = extend({ patchProp }, nodeOps)

// lazy create the renderer - this makes core renderer logic tree-shakable
// in case the user only imports reactivity utilities from Vue.
let renderer: Renderer<Element | ShadowRoot> | HydrationRenderer

let enabledHydration = false

// 这里返回的render 有三个属性 render、hydrate、createApp(createApp是一个函数)
function ensureRenderer() {
  // 1. 如果没有render则才会创建render实例
  // 如果两个调用createApp 返回的 renderer会是一个
  // const a = createApp({}) ; const b = createApp({}) ; ab 两个render实例是一个
  // 2. 为了支持多端渲染
  // 这里只是调用了@vue/runtime-core里的函数
  return (
    renderer ||
    (renderer = createRenderer<Node, Element | ShadowRoot>(rendererOptions))
  )
}

function ensureHydrationRenderer() {
  renderer = enabledHydration
    ? renderer
    : createHydrationRenderer(rendererOptions)
  enabledHydration = true
  return renderer as HydrationRenderer
}

// use explicit type casts here to avoid import() calls in rolled-up d.ts
export const render = ((...args) => {
  ensureRenderer().render(...args)
}) as RootRenderFunction<Element | ShadowRoot>

export const hydrate = ((...args) => {
  ensureHydrationRenderer().hydrate(...args)
}) as RootHydrateFunction

// 创建App实例
export const createApp = ((...args) => {
  // 获取一个充满属性方法的默认app实例
  // 传入的参数：createApp(A（rootComponent）,B （rootProps）)
  // A 会存放于 app._component ==> 后面mount会需要这个
  // B 会存放于 app._props ==> 这个参数会当作dom的属性；style / class
  // 这个app实际上是调用packages/runtime-core/src/apiCreateApp.ts中createAppAPI返回的createApp函数
  // createApp 通过args来接收数据，是因为createAppAPI返回的createApp 可以是多个参数
  // 例：
  // const a = createApp({},1,2,3) (当然实际不会这么传入)
  // 这里的 1 会被createAppAPI返回的createApp 中当作 rootProps（默认是null）;
  const app = ensureRenderer().createApp(...args)

  // 对app.config进行校验 isNativeTag、compilerOptions
  // vue3 中 我们能对createApp创建的实例进行配置操作
  // 例：
  // const app = createApp({}) app.config = { compilerOptions: { isCustomElement:... }  }
  if (__DEV__) {
    injectNativeTagCheck(app)
    // 校验runtimeOnly情况不对app.config.compilerOptions 进行操作
    injectCompilerOptionsCheck(app)
  }

  // 这里重新对mount函数进行封装和上面的render一样 (ensureRenderer => createRenderer)
  // 为了多端渲染，需要开发者基于mount自行实现mount方法
  const { mount } = app
  // mount函数返回的是一个proxy
  app.mount = (containerOrSelector: Element | ShadowRoot | string): any => {
    // 寻找真实dom
    const container = normalizeContainer(containerOrSelector)
    if (!container) return
    // 这里的container
    // 这个app._component是render时传入的第一个参数
    // 见packages/runtime-core/src/apiCreateApp.ts => line 203
    const component = app._component

    // 这里的作用是获得template的内容
    if (!isFunction(component) && !component.render && !component.template) {
      // __UNSAFE__
      // Reason: potential execution of JS expressions in in-DOM template.
      // The user must make sure the in-DOM template is trusted. If it's
      // rendered by the server, the template should not contain any user data.
      component.template = container.innerHTML
      // 2.x compat check
      // __COMPAT__ 是在rollup中定义的。当package.json的buildOptions.compat；在dev环境中 是scripts/dev.js
      // 默认都为false
      if (__COMPAT__ && __DEV__) {
        // 这里是做兼容性处理
        // vue3中容器不是模板的的一部分,即：你在容器上(container)中使用vue的特性代码，是不会被转换的(除了v-cloak除外)；但是在vue2 中、容器是模板的一部分
        for (let i = 0; i < container.attributes.length; i++) {
          const attr = container.attributes[i]
          if (attr.name !== 'v-cloak' && /^(v-|:|@)/.test(attr.name)) {
            compatUtils.warnDeprecation(
              DeprecationTypes.GLOBAL_MOUNT_CONTAINER,
              null
            )
            break
          }
        }
      }
    }
    // clear content before mounting
    // 这里的mount是runtime-core里的mount。
    // 即我们在packages/runtime-core/src/apiCreateApp.ts => 往app上挂载的mount
    container.innerHTML = ''
    const proxy = mount(container, false, container instanceof SVGElement)
    if (container instanceof Element) {
      container.removeAttribute('v-cloak')
      container.setAttribute('data-v-app', '')
    }
    return proxy
  }

  return app
}) as CreateAppFunction<Element>

export const createSSRApp = ((...args) => {
  const app = ensureHydrationRenderer().createApp(...args)

  if (__DEV__) {
    injectNativeTagCheck(app)
    injectCompilerOptionsCheck(app)
  }

  const { mount } = app
  app.mount = (containerOrSelector: Element | ShadowRoot | string): any => {
    const container = normalizeContainer(containerOrSelector)
    if (container) {
      return mount(container, true, container instanceof SVGElement)
    }
  }

  return app
}) as CreateAppFunction<Element>

function injectNativeTagCheck(app: App) {
  // Inject `isNativeTag`
  // this is used for component name validation (dev only)
  Object.defineProperty(app.config, 'isNativeTag', {
    value: (tag: string) => isHTMLTag(tag) || isSVGTag(tag),
    writable: false
  })
}

// dev only
function injectCompilerOptionsCheck(app: App) {
  if (isRuntimeOnly()) {
    const isCustomElement = app.config.isCustomElement
    Object.defineProperty(app.config, 'isCustomElement', {
      get() {
        return isCustomElement
      },
      set() {
        warn(
          `The \`isCustomElement\` config option is deprecated. Use ` +
            `\`compilerOptions.isCustomElement\` instead.`
        )
      }
    })

    const compilerOptions = app.config.compilerOptions
    const msg =
      `The \`compilerOptions\` config option is only respected when using ` +
      `a build of Vue.js that includes the runtime compiler (aka "full build"). ` +
      `Since you are using the runtime-only build, \`compilerOptions\` ` +
      `must be passed to \`@vue/compiler-dom\` in the build setup instead.\n` +
      `- For vue-loader: pass it via vue-loader's \`compilerOptions\` loader option.\n` +
      `- For vue-cli: see https://cli.vuejs.org/guide/webpack.html#modifying-options-of-a-loader\n` +
      `- For vite: pass it via @vitejs/plugin-vue options. See https://github.com/vitejs/vite/tree/main/packages/plugin-vue#example-for-passing-options-to-vuecompiler-dom`

    Object.defineProperty(app.config, 'compilerOptions', {
      get() {
        warn(msg)
        return compilerOptions
      },
      set() {
        warn(msg)
      }
    })
  }
}

// 返回dom
// 即使没有找到dom也会返回原始container
function normalizeContainer(
  container: Element | ShadowRoot | string
): Element | null {
  // 如果传入的字符串就会document.querySelector
  if (isString(container)) {
    const res = document.querySelector(container)
    if (__DEV__ && !res) {
      warn(
        `Failed to mount app: mount target selector "${container}" returned null.`
      )
    }
    return res
  }
  // ShadowRoot => https://developer.mozilla.org/en-US/docs/Web/API/Element/shadowRoot
  if (
    __DEV__ &&
    window.ShadowRoot &&
    container instanceof window.ShadowRoot &&
    container.mode === 'closed'
  ) {
    warn(
      `mounting on a ShadowRoot with \`{mode: "closed"}\` may lead to unpredictable bugs`
    )
  }
  return container as any
}

// Custom element support
export {
  defineCustomElement,
  defineSSRCustomElement,
  VueElement,
  VueElementConstructor
} from './apiCustomElement'

// SFC CSS utilities
export { useCssModule } from './helpers/useCssModule'
export { useCssVars } from './helpers/useCssVars'

// DOM-only components
export { Transition, TransitionProps } from './components/Transition'
export {
  TransitionGroup,
  TransitionGroupProps
} from './components/TransitionGroup'

// **Internal** DOM-only runtime directive helpers
export {
  vModelText,
  vModelCheckbox,
  vModelRadio,
  vModelSelect,
  vModelDynamic
} from './directives/vModel'
export { withModifiers, withKeys } from './directives/vOn'
export { vShow } from './directives/vShow'

import { initVModelForSSR } from './directives/vModel'
import { initVShowForSSR } from './directives/vShow'

let ssrDirectiveInitialized = false

/**
 * @internal
 */
export const initDirectivesForSSR = __SSR__
  ? () => {
      if (!ssrDirectiveInitialized) {
        ssrDirectiveInitialized = true
        initVModelForSSR()
        initVShowForSSR()
      }
    }
  : NOOP

// re-export everything from core
// h, Component, reactivity API, nextTick, flags & types
export * from '@vue/runtime-core'
