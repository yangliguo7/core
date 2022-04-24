//  << 向左移位
// x << y 位 ==>  x * 2 ** y

export const enum ShapeFlags {
  ELEMENT = 1, // 普通dom元素 1
  FUNCTIONAL_COMPONENT = 1 << 1, // 函数组件 2
  STATEFUL_COMPONENT = 1 << 2, // 状态组件 4
  TEXT_CHILDREN = 1 << 3, // 子节点为文本 8
  ARRAY_CHILDREN = 1 << 4, // 子节点为数组 16
  SLOTS_CHILDREN = 1 << 5, // 子节点为插槽 32
  TELEPORT = 1 << 6, // 新的官方内置组件 TELEPORT 64
  SUSPENSE = 1 << 7, // 新的官方内置组件 SUSPENSE 128
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8, // 需要被 keep-alive 的有状态组件 256
  COMPONENT_KEPT_ALIVE = 1 << 9, // 已经被 keep-alive 的有状态组件 512
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT // 有状态组件和函数组件都是组件，用 COMPONENT 表示 1024
}


