import {
  toRaw,
  shallowReactive,
  trigger,
  TriggerOpTypes
} from '@vue/reactivity'
import {
  EMPTY_OBJ,
  camelize,
  hyphenate,
  capitalize,
  isString,
  isFunction,
  isArray,
  isObject,
  hasOwn,
  toRawType,
  PatchFlags,
  makeMap,
  isReservedProp,
  EMPTY_ARR,
  def,
  extend,
  isOn,
  IfAny
} from '@vue/shared'
import { warn } from './warning'
import {
  Data,
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import { isEmitListener } from './componentEmits'
import { InternalObjectKey } from './vnode'
import { AppContext } from './apiCreateApp'
import { createPropsDefaultThis } from './compat/props'
import { isCompatEnabled, softAssertCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'
import { shouldSkipAttr } from './compat/attrsFallthrough'

export type ComponentPropsOptions<P = Data> =
  | ComponentObjectPropsOptions<P>
  | string[]

export type ComponentObjectPropsOptions<P = Data> = {
  [K in keyof P]: Prop<P[K]> | null
}

export type Prop<T, D = T> = PropOptions<T, D> | PropType<T>

type DefaultFactory<T> = (props: Data) => T | null | undefined

export interface PropOptions<T = any, D = T> {
  type?: PropType<T> | true | null
  required?: boolean
  default?: D | DefaultFactory<D> | null | undefined | object
  validator?(value: unknown): boolean
}

export type PropType<T> = PropConstructor<T> | PropConstructor<T>[]

type PropConstructor<T = any> =
  | { new (...args: any[]): T & {} }
  | { (): T }
  | PropMethod<T>

type PropMethod<T, TConstructor = any> = [T] extends [
  ((...args: any) => any) | undefined
] // if is function with args, allowing non-required functions
  ? { new (): TConstructor; (): T; readonly prototype: TConstructor } // Create Function like constructor
  : never

type RequiredKeys<T> = {
  [K in keyof T]: T[K] extends
    | { required: true }
    | { default: any }
    // don't mark Boolean props as undefined
    | BooleanConstructor
    | { type: BooleanConstructor }
    ? T[K] extends { default: undefined | (() => undefined) }
      ? never
      : K
    : never
}[keyof T]

type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>

type DefaultKeys<T> = {
  [K in keyof T]: T[K] extends
    | { default: any }
    // Boolean implicitly defaults to false
    | BooleanConstructor
    | { type: BooleanConstructor }
    ? T[K] extends { type: BooleanConstructor; required: true } // not default if Boolean is marked as required
      ? never
      : K
    : never
}[keyof T]

type InferPropType<T> = [T] extends [null]
  ? any // null & true would fail to infer
  : [T] extends [{ type: null | true }]
  ? any // As TS issue https://github.com/Microsoft/TypeScript/issues/14829 // somehow `ObjectConstructor` when inferred from { (): T } becomes `any` // `BooleanConstructor` when inferred from PropConstructor(with PropMethod) becomes `Boolean`
  : [T] extends [ObjectConstructor | { type: ObjectConstructor }]
  ? Record<string, any>
  : [T] extends [BooleanConstructor | { type: BooleanConstructor }]
  ? boolean
  : [T] extends [DateConstructor | { type: DateConstructor }]
  ? Date
  : [T] extends [(infer U)[] | { type: (infer U)[] }]
  ? U extends DateConstructor
    ? Date | InferPropType<U>
    : InferPropType<U>
  : [T] extends [Prop<infer V, infer D>]
  ? unknown extends V
    ? IfAny<V, V, D>
    : V
  : T

export type ExtractPropTypes<O> = {
  // use `keyof Pick<O, RequiredKeys<O>>` instead of `RequiredKeys<O>` to support IDE features
  [K in keyof Pick<O, RequiredKeys<O>>]: InferPropType<O[K]>
} & {
  // use `keyof Pick<O, OptionalKeys<O>>` instead of `OptionalKeys<O>` to support IDE features
  [K in keyof Pick<O, OptionalKeys<O>>]?: InferPropType<O[K]>
}

const enum BooleanFlags {
  shouldCast,
  shouldCastTrue
}

// extract props which defined with default from prop options
export type ExtractDefaultPropTypes<O> = O extends object
  ? { [K in DefaultKeys<O>]: InferPropType<O[K]> }
  : {}

type NormalizedProp =
  | null
  | (PropOptions & {
      [BooleanFlags.shouldCast]?: boolean
      [BooleanFlags.shouldCastTrue]?: boolean
    })

// normalized value is a tuple of the actual normalized options
// and an array of prop keys that need value casting (booleans and defaults)
export type NormalizedProps = Record<string, NormalizedProp>
export type NormalizedPropsOptions = [NormalizedProps, string[]] | []

export function initProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  isStateful: number, // result of bitwise flag comparison
  isSSR = false
) {

  const props: Data = {}
  const attrs: Data = {}
  // 属性上定义__vInternal 数值为1
  // def => Object.defineProperty
  def(attrs, InternalObjectKey, 1)

  instance.propsDefaults = Object.create(null)
  // fixme 这里是做什么的
  setFullProps(instance, rawProps, props, attrs)

  // ensure all declared prop keys are present
  for (const key in instance.propsOptions[0]) {
    if (!(key in props)) {
      props[key] = undefined
    }
  }

  // validation
  if (__DEV__) {
    validateProps(rawProps || {}, props, instance)
  }

  if (isStateful) {
    // stateful
    instance.props = isSSR ? props : shallowReactive(props)
  } else {
    if (!instance.type.props) {
      // functional w/ optional props, props === attrs
      instance.props = attrs
    } else {
      // functional w/ declared props
      instance.props = props
    }
  }
  instance.attrs = attrs
}

export function updateProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  rawPrevProps: Data | null,
  optimized: boolean
) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance
  const rawCurrentProps = toRaw(props)
  const [options] = instance.propsOptions
  let hasAttrsChanged = false

  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    !(
      __DEV__ &&
      (instance.type.__hmrId ||
        (instance.parent && instance.parent.type.__hmrId))
    ) &&
    (optimized || patchFlag > 0) &&
    !(patchFlag & PatchFlags.FULL_PROPS)
  ) {
    if (patchFlag & PatchFlags.PROPS) {
      // Compiler-generated props & no keys change, just set the updated
      // the props.
      const propsToUpdate = instance.vnode.dynamicProps!
      for (let i = 0; i < propsToUpdate.length; i++) {
        let key = propsToUpdate[i]
        // skip if the prop key is a declared emit event listener
        if (isEmitListener(instance.emitsOptions, key)) {
          continue
        }
        // PROPS flag guarantees rawProps to be non-null
        const value = rawProps![key]
        if (options) {
          // attr / props separation was done on init and will be consistent
          // in this code path, so just check if attrs have it.
          if (hasOwn(attrs, key)) {
            if (value !== attrs[key]) {
              attrs[key] = value
              hasAttrsChanged = true
            }
          } else {
            const camelizedKey = camelize(key)
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance,
              false /* isAbsent */
            )
          }
        } else {
          if (__COMPAT__) {
            if (isOn(key) && key.endsWith('Native')) {
              key = key.slice(0, -6) // remove Native postfix
            } else if (shouldSkipAttr(key, instance)) {
              continue
            }
          }
          if (value !== attrs[key]) {
            attrs[key] = value
            hasAttrsChanged = true
          }
        }
      }
    }
  } else {
    // full props update.
    if (setFullProps(instance, rawProps, props, attrs)) {
      hasAttrsChanged = true
    }
    // in case of dynamic props, check if we need to delete keys from
    // the props object
    let kebabKey: string
    for (const key in rawCurrentProps) {
      if (
        !rawProps ||
        // for camelCase
        (!hasOwn(rawProps, key) &&
          // it's possible the original props was passed in as kebab-case
          // and converted to camelCase (#955)
          ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))
      ) {
        if (options) {
          if (
            rawPrevProps &&
            // for camelCase
            (rawPrevProps[key] !== undefined ||
              // for kebab-case
              rawPrevProps[kebabKey!] !== undefined)
          ) {
            props[key] = resolvePropValue(
              options,
              rawCurrentProps,
              key,
              undefined,
              instance,
              true /* isAbsent */
            )
          }
        } else {
          delete props[key]
        }
      }
    }
    // in the case of functional component w/o props declaration, props and
    // attrs point to the same object so it should already have been updated.
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (
          !rawProps ||
          (!hasOwn(rawProps, key) &&
            (!__COMPAT__ || !hasOwn(rawProps, key + 'Native')))
        ) {
          delete attrs[key]
          hasAttrsChanged = true
        }
      }
    }
  }

  // trigger updates for $attrs in case it's used in component slots
  if (hasAttrsChanged) {
    trigger(instance, TriggerOpTypes.SET, '$attrs')
  }

  if (__DEV__) {
    validateProps(rawProps || {}, props, instance)
  }
}

// 这个方式是往props 和 attrs上赋值；
function setFullProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null, // 父组件向子组件传入的props数据，(<aaa :name=xxx :age=xxx ref=xx @do=xxx />)
  props: Data, // 最终的props
  attrs: Data // 最终的attrs
) {
  // packages/runtime-core/src/component.ts => createComponentInstance中
  // 我们在 instance 上定义 propsOptions; 数据来源于 normalizePropsOptions
  // options NormalizedProps； 为 mixin上的props、本身的props 对象
  // needCastKeys string []; 为需要转化的key；(如果type为Boolean 或者 props 有默认值)
  const [options, needCastKeys] = instance.propsOptions
  let hasAttrsChanged = false
  let rawCastValues: Data | undefined // 需要转换的props 对象

  if (rawProps) {
    for (let key in rawProps) {
      // key, ref are reserved and never passed down
      if (isReservedProp(key)) {
        continue
      }

      if (__COMPAT__) {
        if (key.startsWith('onHook:')) {
          softAssertCompatEnabled(
            DeprecationTypes.INSTANCE_EVENT_HOOKS,
            instance,
            key.slice(2).toLowerCase()
          )
        }
        if (key === 'inline-template') {
          continue
        }
      }

      const value = rawProps[key]
      // prop option names are camelized during normalization, so to support
      // kebab -> camel conversion here we need to camelize the key.
      let camelKey
      // 如果传入的props匹配到了propsOptions (extend、mixin、本身定义的props)
      if (options && hasOwn(options, (camelKey = camelize(key)))) {
        if (!needCastKeys || !needCastKeys.includes(camelKey)) { // 如果不需要转换
          props[camelKey] = value
        } else {
          // 否则往rawCastValues上添加;rawCastValues 包含 有默认值或者type为Boolean的props下 传入的props数据
          // 这里的意思是说 往对象rawCastValues上添加一个 key 为 camelKey，值为 value
          ;(rawCastValues || (rawCastValues = {}))[camelKey] = value
        }
        // 如果不是 emitsOptions(extend、mixin、本身 上定义的emits 属性)上的
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        // emitsOptions 是 normalizeEmitsOptions(packages/runtime-core/src/component.ts)中来的；本身和mixin来的emitOption
        // Any non-declared (either as a prop or an emitted event) props are put
        // into a separate `attrs` object for spreading. Make sure to preserve
        // original key casing
        if (__COMPAT__) {
          if (isOn(key) && key.endsWith('Native')) {
            key = key.slice(0, -6) // remove Native postfix
          } else if (shouldSkipAttr(key, instance)) {
            continue
          }
        }
        // 假设在组件中传入了 class style aaa bbb 这种属性；则会把他解析为attrs
        // 这些属性 没定义在propsOptions(属性为 props)和emitsOptions(属性为 emits)
        if (!(key in attrs) || value !== attrs[key]) {
          attrs[key] = value
          hasAttrsChanged = true
        }
      }
    }
  }

  if (needCastKeys) {
    const rawCurrentProps = toRaw(props)
    const castValues = rawCastValues || EMPTY_OBJ
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i]
      props[key] = resolvePropValue(
        options!,
        rawCurrentProps,
        key,
        castValues[key],
        instance,
        !hasOwn(castValues, key)
      )
    }
  }

  return hasAttrsChanged
}

// 针对需要转换( type为Boolean;type Boolean、String )的数据进行props解析
function resolvePropValue(
  options: NormalizedProps,
  props: Data,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance,
  isAbsent: boolean // 是否没有传入这个参数；用于判断boolean值；比如prop:{ A:[Boolean] }，但是并未传递这个A参数，则isAbsent（!hasOwn(castValues, key)） 为true
) {

  const opt = options[key] // props上定义的
  if (opt != null) {
    const hasDefault = hasOwn(opt, 'default')
    // default values
    if (hasDefault && value === undefined) { // 有默认值 并且props上 我未传递这个值
      const defaultValue = opt.default
      if (opt.type !== Function && isFunction(defaultValue)) { // 针对default为一个函数
        // initProps 函数中定义为 {}；Line 166
        const { propsDefaults } = instance
        if (key in propsDefaults) {
          value = propsDefaults[key]
        } else {
          setCurrentInstance(instance)
          // 回调default函数，同时instance.propsDefaults 上赋值属性
          value = propsDefaults[key] = defaultValue.call(
            __COMPAT__ &&
              isCompatEnabled(DeprecationTypes.PROPS_DEFAULT_THIS, instance)
              ? createPropsDefaultThis(instance, props, key)
              : null,
            props
          )
          unsetCurrentInstance()
        }
      } else {
        value = defaultValue
      }
    }
    if (opt[BooleanFlags.shouldCast]) { // 当type中有Boolean值是 为true
      if (isAbsent && !hasDefault) {
        value = false // props默认为false
      } else if (
        opt[BooleanFlags.shouldCastTrue] && // 当type中没有string 或者 prop中 先 Boolean 在 string；这里只会存在[...Boolean....String .....]这种的情况
        (value === '' || value === hyphenate(key))
      ) {
        value = true
      }
    }
  }
  return value
}

// 获取一个key为comp 、值为props的 weakSet
// 这里的weakSet 包含所有mixin和本身；
export function normalizePropsOptions(
  comp: ConcreteComponent, // component对象
  appContext: AppContext, // 父类的VNODE.appContext (createAppContext函数返回的context)
  asMixin = false // 标识是否是mixin；如果是mixin则不处理appContext上的mixin
): NormalizedPropsOptions {
  // appContext 是父类的appContext (packages/runtime-core/src/component.ts 459Line)；会一直到root
  // propsCache是包含全局mixin、组件extend、组件mixin、本身的部分
  // 这里并不是说对props去重。因为对于全局mixin中，每个组件appContext都会有全局mixin
  // 这里cache将存储所有的props
  const cache = appContext.propsCache
  const cached = cache.get(comp)
  if (cached) {
    return cached
  }

  const raw = comp.props
  // 存储props的 的对象
  const normalized: NormalizedPropsOptions[0] = {}
  // 存储需要转换的key数组
  const needCastKeys: NormalizedPropsOptions[1] = []

  // apply mixin/extends props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendProps = (raw: ComponentOptions) => {
      if (__COMPAT__ && isFunction(raw)) {
        raw = raw.options
      }
      hasExtends = true
      const [props, keys] = normalizePropsOptions(raw, appContext, true) // 注意这里的asMixin为true
      extend(normalized, props) // 这里会有覆盖的情况，后出现的props会替换之前的
      if (keys) needCastKeys.push(...keys)
    }
    // 全局如果有mixin; Line 486 会有去重操作;父类本身的mixin是走 Line 519
    // 因为每次循环传递的都是appContext，如果不做一个asMixin判断则会无限递归
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps)
    }
    if (comp.extends) {
      extendProps(comp.extends)
    }
    // 本身(即 对象上有mixin属性)如果有mixin
    // 注意 这里可以看出 ；他先执行父类的mixin;然后在执行自身得minxin；因此自身得mixin会替换父类得minxin
    if (comp.mixins) {
      comp.mixins.forEach(extendProps)
    }
  }

  // 不存在props 也会放一个空
  // fixme 为什么这里需要放一个空对象
  if (!raw && !hasExtends) {
    cache.set(comp, EMPTY_ARR as any)
    return EMPTY_ARR as any
  }

  // props:['A','B']的情况
  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      if (__DEV__ && !isString(raw[i])) {
        warn(`props must be strings when using array syntax.`, raw[i])
      }
      // props => a-b => aB 驼峰
      const normalizedKey = camelize(raw[i])
      // 对于 $ 开头的props 不做处理；字符会会统一补充value 为 EMPTY_OBJ
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ
      }
    }
  } else if (raw) {
    // 针对 props:{
    //  a:{},
    //  c:{}
    // }
    if (__DEV__ && !isObject(raw)) {
      warn(`invalid props options`, raw)
    }
    for (const key in raw) {
      const normalizedKey = camelize(key)
      if (validatePropName(normalizedKey)) {
        const opt = raw[key]
        // 如果是 props:{propA:['a'], propB:()=>{},propC:String,,propD:[String,Boolean]} 都会变成 xxx:{ type:xxx }
        // 这个prop 就是 normalized[normalizedKey]；下面给prop 01 赋值就是给normalized[normalizedKey] 赋值
        const prop: NormalizedProp = (normalized[normalizedKey] =
          isArray(opt) || isFunction(opt) ? { type: opt } : opt)
        if (prop) {
          const booleanIndex = getTypeIndex(Boolean, prop.type)
          const stringIndex = getTypeIndex(String, prop.type)
          // 这个表示 type中 是否有 boolean
          prop[BooleanFlags.shouldCast] = booleanIndex > -1
          // 这个表示 如果type中没有string 或者 propA中 先 Boolean 在 string
          prop[BooleanFlags.shouldCastTrue] = // type:[String，Boolean.....] 这种情况
            stringIndex < 0 || booleanIndex < stringIndex
          // 上面这个两个参数的意义在于：在 setFullProps => resolvePropValue 函数中
          // 针对type为Boolean的props，但是并未传递次props的数据，应该如何设置默认值
          // if the prop needs boolean casting or default value
          // https://staging-cn.vuejs.org/guide/components/props.html#boolean-casting Boolean 类型转换
          if (booleanIndex > -1 || hasOwn(prop, 'default')) {
            needCastKeys.push(normalizedKey)
          }
        }
      }
    }
  }

  // normalized 即组件涉及到props( 转换后的props )
  // needCastKeys 这是记录所有需要转换的参数。当type为Boolean 或者 [String、Boolean] 这种类型，应该特殊处理
  // setFullProps 函数中，处理传入的props数据会用到
  const res: NormalizedPropsOptions = [normalized, needCastKeys]
  cache.set(comp, res)
  return res
}

// 校验key不以$ 开头
function validatePropName(key: string) {
  if (key[0] !== '$') {
    return true
  } else if (__DEV__) {
    warn(`Invalid prop name: "${key}" is a reserved property.`)
  }
  return false
}

// use function string name to check type constructors
// so that it works across vms / iframes.
// 这个函数 function xx(){} ; ==> xx; null ==> 'null' ; 其余都是 ''
function getType(ctor: Prop<any>): string {
  const match = ctor && ctor.toString().match(/^\s*function (\w+)/)
  return match ? match[1] : ctor === null ? 'null' : '' // match[1] 这里是函数名称
}

function isSameType(a: Prop<any>, b: Prop<any>): boolean {
  return getType(a) === getType(b)
}

// 判断原始类型(String、Boolean)在不在
function getTypeIndex(
  type: Prop<any>, // 原始类型 String、Boolean
  expectedTypes: PropType<any> | void | null | true
): number {
  if (isArray(expectedTypes)) {
    return expectedTypes.findIndex(t => isSameType(t, type))
  } else if (isFunction(expectedTypes)) {
    return isSameType(expectedTypes, type) ? 0 : -1
  }
  return -1
}

/**
 * dev only
 */
function validateProps(
  rawProps: Data,
  props: Data,
  instance: ComponentInternalInstance
) {
  const resolvedValues = toRaw(props)
  const options = instance.propsOptions[0]
  for (const key in options) {
    let opt = options[key]
    if (opt == null) continue
    validateProp(
      key,
      resolvedValues[key],
      opt,
      !hasOwn(rawProps, key) && !hasOwn(rawProps, hyphenate(key))
    )
  }
}

/**
 * dev only
 */
function validateProp(
  name: string,
  value: unknown,
  prop: PropOptions,
  isAbsent: boolean
) {
  const { type, required, validator } = prop
  // required!
  if (required && isAbsent) {
    warn('Missing required prop: "' + name + '"')
    return
  }
  // missing but optional
  if (value == null && !prop.required) {
    return
  }
  // type check
  if (type != null && type !== true) {
    let isValid = false
    const types = isArray(type) ? type : [type]
    const expectedTypes = []
    // value is valid as long as one of the specified types match
    for (let i = 0; i < types.length && !isValid; i++) {
      const { valid, expectedType } = assertType(value, types[i])
      expectedTypes.push(expectedType || '')
      isValid = valid
    }
    if (!isValid) {
      warn(getInvalidTypeMessage(name, value, expectedTypes))
      return
    }
  }
  // custom validator
  if (validator && !validator(value)) {
    warn('Invalid prop: custom validator check failed for prop "' + name + '".')
  }
}

const isSimpleType = /*#__PURE__*/ makeMap(
  'String,Number,Boolean,Function,Symbol,BigInt'
)

type AssertionResult = {
  valid: boolean
  expectedType: string
}

/**
 * dev only
 */
function assertType(value: unknown, type: PropConstructor): AssertionResult {
  let valid
  const expectedType = getType(type)
  if (isSimpleType(expectedType)) {
    const t = typeof value
    valid = t === expectedType.toLowerCase()
    // for primitive wrapper objects
    if (!valid && t === 'object') {
      valid = value instanceof type
    }
  } else if (expectedType === 'Object') {
    valid = isObject(value)
  } else if (expectedType === 'Array') {
    valid = isArray(value)
  } else if (expectedType === 'null') {
    valid = value === null
  } else {
    valid = value instanceof type
  }
  return {
    valid,
    expectedType
  }
}

/**
 * dev only
 */
function getInvalidTypeMessage(
  name: string,
  value: unknown,
  expectedTypes: string[]
): string {
  let message =
    `Invalid prop: type check failed for prop "${name}".` +
    ` Expected ${expectedTypes.map(capitalize).join(' | ')}`
  const expectedType = expectedTypes[0]
  const receivedType = toRawType(value)
  const expectedValue = styleValue(value, expectedType)
  const receivedValue = styleValue(value, receivedType)
  // check if we need to specify expected value
  if (
    expectedTypes.length === 1 &&
    isExplicable(expectedType) &&
    !isBoolean(expectedType, receivedType)
  ) {
    message += ` with value ${expectedValue}`
  }
  message += `, got ${receivedType} `
  // check if we need to specify received value
  if (isExplicable(receivedType)) {
    message += `with value ${receivedValue}.`
  }
  return message
}

/**
 * dev only
 */
function styleValue(value: unknown, type: string): string {
  if (type === 'String') {
    return `"${value}"`
  } else if (type === 'Number') {
    return `${Number(value)}`
  } else {
    return `${value}`
  }
}

/**
 * dev only
 */
function isExplicable(type: string): boolean {
  const explicitTypes = ['string', 'number', 'boolean']
  return explicitTypes.some(elem => type.toLowerCase() === elem)
}

/**
 * dev only
 */
function isBoolean(...args: string[]): boolean {
  return args.some(elem => elem.toLowerCase() === 'boolean')
}
