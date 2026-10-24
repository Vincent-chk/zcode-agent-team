// 展开/收起行为（§10.6 原文语义；面板与 ::visualize 卡片共用 = 单一实现）。
// 规则：描述实测溢出（scrollHeight > clientHeight + 1，ResizeObserver 持续测量）或已展开
// 时才渲染开关；点击切换 expanded；aria-expanded 同步；chevron 旋转由 CSS（.open svg）承担。
// DOM 依赖 → 仅浏览器载体调用（vitest 环境无 DOM，本模块不进 node 单测面，
// 行为由 T5.6 视觉回归 DOM 断言 + 面板实机验收 F05 覆盖）。

export interface ExpandStore {
  isExpanded(taskId: string): boolean;
  setExpanded(taskId: string, expanded: boolean): void;
}

/** 内存展开态（面板 = widgetState 持久化；卡片 = window.zcode.widgetState）。 */
export function memoryExpandStore(initial?: ReadonlySet<string>): ExpandStore {
  const set = new Set(initial ?? []);
  return {
    isExpanded: (id) => set.has(id),
    setExpanded: (id, v) => {
      if (v) set.add(id);
      else set.delete(id);
    },
  };
}

export interface ExpandLabels {
  expand: string;
  collapse: string;
}

/**
 * 给容器内全部任务卡挂展开行为（事件委托 + 每卡 ResizeObserver）。
 * 返回 detach（清理观察器；面板重渲染前调用防泄漏）。
 * 容器结构约定（ui-core/render.ts 产出）：article.task[data-task-id] >
 * button.expand-toggle[data-task-toggle] + p[data-task-desc]。
 */
export function attachExpandBehavior(
  root: HTMLElement,
  store: ExpandStore,
  labels: ExpandLabels,
): () => void {
  const observers: ResizeObserver[] = [];
  const measure = (task: HTMLElement): void => {
    const desc = task.querySelector<HTMLElement>("[data-task-desc]");
    const toggle = task.querySelector<HTMLButtonElement>("[data-task-toggle]");
    if (desc === null || toggle === null) return;
    const id = task.dataset.taskId ?? "";
    const expanded = store.isExpanded(id);
    // §10.6 原文语义：溢出判定 = scrollHeight > clientHeight + 1（clamp 态下测量）
    const overflow = desc.scrollHeight > desc.clientHeight + 1;
    toggle.hidden = !(overflow || expanded);
    const label = toggle.querySelector<HTMLElement>(".expand-label");
    if (label !== null) label.textContent = expanded ? labels.collapse : labels.expand;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.classList.toggle("open", expanded);
    desc.classList.toggle("expanded", expanded);
  };

  const tasks = () => Array.from(root.querySelectorAll<HTMLElement>("article.task"));
  for (const task of tasks()) {
    const desc = task.querySelector<HTMLElement>("[data-task-desc]");
    if (desc !== null && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => measure(task));
      ro.observe(desc);
      observers.push(ro);
    }
    measure(task);
  }

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    const toggle = target?.closest<HTMLButtonElement>("[data-task-toggle]");
    if (toggle === null || toggle === undefined) return;
    const task = toggle.closest<HTMLElement>("article.task");
    if (task === null) return;
    const id = task.dataset.taskId ?? "";
    store.setExpanded(id, !store.isExpanded(id));
    measure(task);
  };
  root.addEventListener("click", onClick);

  return () => {
    root.removeEventListener("click", onClick);
    for (const ro of observers) ro.disconnect();
  };
}
