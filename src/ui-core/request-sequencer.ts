// 请求序号（面板/伴生页共用）：并发请求只允许最后一次的结果落地。
// 用法：begin() 取号 → await → isCurrent(seq) 才应用；invalidate() 让所有在途结果失效
// （如关闭详情视图时）。纯 UI 层状态，无 I/O。
export class RequestSequencer {
  #seq = 0;

  begin(): number {
    this.#seq += 1;
    return this.#seq;
  }

  isCurrent(seq: number): boolean {
    return seq === this.#seq;
  }

  invalidate(): void {
    this.#seq += 1;
  }
}
