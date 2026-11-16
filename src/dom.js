/** 画面側の基本操作を共有し、公開物では長い DOM メソッド名の繰り返しを省く。 */

/** 登録先が非対応の API（visualViewport など）なら何もせず、イベントの引数はそのまま渡す。 */
export function listen(target, type, listener, options) {
  target?.addEventListener(type, listener, options);
}

export const element = (tag) => document.createElement(tag);
export const attribute = (target, name, value) => target.setAttribute(name, value);
