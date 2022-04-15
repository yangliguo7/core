import { isArray, isString, isObject, hyphenate } from './'
import { isNoUnitNumericStyleProp } from './domAttrConfig'

export type NormalizedStyle = Record<string, string | number>

// 转换style属性
// str => str
// object => obj
// str|object|array [] => normalizeStyle(str=>parseStringStyle ;obj=> key()要求value必须为正值)
export function normalizeStyle(
  value: unknown
): NormalizedStyle | string | undefined {
  if (isArray(value)) {
    const res: NormalizedStyle = {}
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      const normalized = isString(item) // 注意只要数组里的字符串才会进行parseStringStyle；对于直接传入的字符串则会直接返回
        ? parseStringStyle(item)
        : (normalizeStyle(item) as NormalizedStyle)
      if (normalized) {
        for (const key in normalized) {
          res[key] = normalized[key]
        }
      }
    }
    return res
  } else if (isString(value)) {
    return value
  } else if (isObject(value)) {
    return value
  }
}

// x(?!y) => 'x'后面不跟着'y'时匹配'x'，这被称为正向否定查找。
// parseStyle 解析整个style 字符串
const listDelimiterRE = /;(?![^(]*\))/g // 匹配后面不跟着()的;
// parseStyle 解析上面正则解析出的数据 进行单个解析
const propertyDelimiterRE = /:(.+)/ // 匹配后面有字符的:

// 处理style 对应的字符串; 以;分割后的字符字符、以:分割为key:value
// '123'(不包含;) => {}
// '123:abb' => {123:abb}
// '123:abb(这是注释)' => {123:abb(这是注释)}
// '123:abb;(这是注释)' => {123:abb}
// '123:abb;456:cdd' => {123:abb,456:cdd}
// ASD;cdd =>{}
export function parseStringStyle(cssText: string): NormalizedStyle {
  const ret: NormalizedStyle = {}
  cssText.split(listDelimiterRE).forEach(item => {
    if (item) {
      // 要求单个的字符串包含:
      const tmp = item.split(propertyDelimiterRE)
      tmp.length > 1 && (ret[tmp[0].trim()] = tmp[1].trim())
    }
  })
  return ret
}

export function stringifyStyle(
  styles: NormalizedStyle | string | undefined
): string {
  let ret = ''
  if (!styles || isString(styles)) {
    return ret
  }
  for (const key in styles) {
    const value = styles[key]
    const normalizedKey = key.startsWith(`--`) ? key : hyphenate(key)
    if (
      isString(value) ||
      (typeof value === 'number' && isNoUnitNumericStyleProp(normalizedKey))
    ) {
      // only render valid values
      ret += `${normalizedKey}:${value};`
    }
  }
  return ret
}



// 转换class ;
// str => str 'classA' => 'classA';
// string | object [] => normalizeClass ['classA','classB'] => 'classA classB';
// object => object.value {key:value,key2:value2} => 'key key2';
export function normalizeClass(value: unknown): string {
  let res = ''
  if (isString(value)) {
    res = value
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeClass(value[i])
      if (normalized) {
        res += normalized + ' '
      }
    }
  } else if (isObject(value)) {
    for (const name in value) {
      if (value[name]) { // 注意value有值时才会把name加上
        res += name + ' '
      }
    }
  }
  return res.trim()
}

export function normalizeProps(props: Record<string, any> | null) {
  if (!props) return null
  let { class: klass, style } = props
  if (klass && !isString(klass)) {
    props.class = normalizeClass(klass)
  }
  if (style) {
    props.style = normalizeStyle(style)
  }
  return props
}
