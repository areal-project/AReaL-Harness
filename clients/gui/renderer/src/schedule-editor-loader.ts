export type ScheduleEditorState<T> = {
  editor: T | null;
  loading: boolean;
  error: string;
  editing: boolean;
};

/** 编辑器代码可缓存；异步回包只能打开发起它的任务，换任务和卸载使旧代次失效。 */
export function createScheduleEditorLoader<T>(
  load: () => Promise<T>,
  publish: (state: ScheduleEditorState<T>) => void,
) {
  let editor: T | null = null;
  let generation = 0;
  let pending = false;
  const state = (loading = false, error = "", editing = false) =>
    publish({ editor, loading, error, editing });
  const invalidate = () => {
    generation++;
    pending = false;
  };
  return {
    invalidate,
    reset() {
      invalidate();
      state();
    },
    async open() {
      if (editor) return state(false, "", true);
      if (pending) return;
      pending = true;
      const request = ++generation;
      state(true);
      try {
        const loaded = await load();
        if (request !== generation) return;
        editor = loaded;
        state(false, "", true);
      } catch (cause) {
        if (request === generation)
          state(false, cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request === generation) pending = false;
      }
    },
  };
}
