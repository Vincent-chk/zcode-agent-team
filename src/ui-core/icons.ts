// 内联图标（V14：风格与宿主图标族一致，形状等价即可，不引外部图标库/vendor）。
// 全部 14px 描边线性图标，currentColor 上色（跟随语义令牌）。
//  - user：等价 DSH IconUserOutlineRegular（inactive 成员，§10.5）；
//  - users：触发器等价 IconUsersOutlineRegular（面板标题/CLI 引导，§10.2）；
//  - chevron：展开开关（§10.6，12px，旋转 180°）；
//  - arrowLeft：T5.7 详情返回（无 DSH 参照，宿主风格）。

const svg = (inner: string, size: number): string =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
  `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/** inactive 成员人形图标（14px；等价 IconUserOutlineRegular）。 */
export function iconUser(size = 14): string {
  return svg('<circle cx="8" cy="5.5" r="3"/><path d="M2.6 14c.7-2.9 2.9-4.2 5.4-4.2s4.7 1.3 5.4 4.2"/>', size);
}

/** 触发器/标题图标（14px；等价 IconUsersOutlineRegular，双人形）。 */
export function iconUsers(size = 14): string {
  return svg(
    '<circle cx="6.2" cy="5.6" r="2.6"/><path d="M1.8 13.4c.6-2.5 2.4-3.6 4.4-3.6s3.8 1.1 4.4 3.6"/>' +
      '<path d="M10.6 3.4a2.5 2.5 0 0 1 0 4.9"/><path d="M11.6 9.9c1.7.3 2.7 1.4 3.1 3.5"/>',
    size,
  );
}

/** 展开开关 chevron（12px；展开时 CSS 旋转 180°）。 */
export function iconChevron(size = 12): string {
  return svg('<path d="M4 6.2 8 10.2 12 6.2"/>', size);
}

/** 详情返回箭头（14px；T5.7，宿主风格）。 */
export function iconArrowLeft(size = 14): string {
  return svg('<path d="M9.5 3.5 5 8l4.5 4.5"/><path d="M5 8h8"/>', size);
}
