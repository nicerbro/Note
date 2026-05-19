(function () {
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  if (typeof invoke !== "function") return;

  function markDesktopShell() {
    if (document.documentElement) {
      document.documentElement.classList.add("desktop-shell");
      return;
    }

    window.addEventListener("DOMContentLoaded", () => {
      document.documentElement.classList.add("desktop-shell");
    }, { once: true });
  }

  markDesktopShell();

  window.noteStorage = {
    load: () => invoke("storage_load"),
    save: (data) => invoke("storage_save", { data })
  };

  window.desktopWindow = {
    isDesktop: true,
    setAlwaysOnTop: (enabled) => invoke("window_set_always_on_top", { enabled: Boolean(enabled) }),
    hide: () => invoke("window_hide"),
    close: () => invoke("window_hide"),
    startDragging: () => invoke("window_start_dragging"),
    startResizeDragging: (edge) => invoke("window_start_resize_dragging", { edge }),
    beginMove: (point) => invoke("window_begin_move", { point }),
    moveTo: (point) => invoke("window_move_to", { point }),
    endMove: () => invoke("window_end_move"),
    beginResize: (edge, point) => invoke("window_begin_resize", { edge, point }),
    resizeTo: (point) => invoke("window_resize_to", { point }),
    endResize: () => invoke("window_end_resize")
  };
})();
