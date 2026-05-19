const STORAGE_KEY = "floating-note-state-v2";
    const LEGACY_STATE_KEY = "floating-note-state-v1";
    const LEGACY_NOTES_KEY = "desktop-notes";
    const LEGACY_TODOS_KEY = "desktop-todos";

    const defaultState = {
      mode: "notes",
      taskView: "pending",
      pinned: false,
      visible: true,
      search: "",
      editingNoteId: null,
      editingTaskId: null,
      expandedNoteIds: [],
      windowX: 0,
      windowY: 0,
      draftNote: { title: "", content: "" },
      notes: [],
      tasks: []
    };

    let state = structuredClone(defaultState);

    const stage = document.getElementById("stage");
    const app = document.getElementById("app");
    const content = document.getElementById("content");
    const searchInput = document.getElementById("searchInput");
    const createBtn = document.getElementById("createBtn");
    const pinBtn = document.getElementById("pinBtn");
    const closeBtn = document.getElementById("closeBtn");
    const launcher = document.getElementById("launcher");

    init();

    async function init() {
      if (window.desktopWindow && window.desktopWindow.isDesktop) {
        document.documentElement.classList.add("desktop-shell");
      }
      state = normalizeState(await loadAppState());
      bindEvents();
      render();
      syncAlwaysOnTop();
    }

    function bindEvents() {
      document.querySelectorAll(".segment").forEach((button) => {
        button.addEventListener("click", () => {
          cleanupEmptyDraftTasks();
          state.mode = button.dataset.mode;
          state.search = "";
          state.editingTaskId = null;
          persistAndRender();
        });
      });

      createBtn.addEventListener("click", () => {
        if (state.mode === "notes") {
          state.editingNoteId = "new";
          state.draftNote = { title: "", content: "" };
        } else {
          addBlankTask();
        }
        persistAndRender();
      });

      searchInput.addEventListener("input", (event) => {
        state.search = event.target.value;
        saveAppState();
        renderContent();
      });

      pinBtn.addEventListener("click", async () => {
        state.pinned = !state.pinned;
        await syncAlwaysOnTop();
        await saveAppState();
        renderChrome();
      });

      closeBtn.addEventListener("click", async () => {
        if (window.desktopWindow && typeof window.desktopWindow.hide === "function") {
          await saveAppState();
          await window.desktopWindow.hide();
          return;
        }
        state.visible = false;
        cleanupEmptyDraftTasks();
        saveAppState();
        renderChrome();
      });

      document.addEventListener("click", (event) => {
        if (state.mode !== "tasks" || !state.editingTaskId) return;
        if (event.target.closest(".task-row.editing")) return;
        saveCurrentTaskEdit({ deferRender: true });
      }, true);

      document.addEventListener("click", () => {
        closeInlineDeleteConfirms();
      });

      launcher.addEventListener("click", () => {
        state.visible = true;
        saveAppState();
        renderChrome();
      });

      bindWindowDrag();
      bindWindowResize();

      window.addEventListener("keydown", (event) => {
        if (window.desktopWindow && window.desktopWindow.isDesktop) return;
        if (event.ctrlKey && event.key.toLowerCase() === "n") {
          event.preventDefault();
          state.visible = !state.visible;
          if (!state.visible) cleanupEmptyDraftTasks();
          persistAndRender();
        }
      });
    }

    function bindWindowDrag() {
      const topbar = document.querySelector(".topbar");
      const desktopWindow = window.desktopWindow;
      const canStartNativeDrag = Boolean(
        desktopWindow &&
        desktopWindow.isDesktop &&
        typeof desktopWindow.startDragging === "function"
      );
      const canMoveDesktopWindow = Boolean(
        desktopWindow &&
        desktopWindow.isDesktop &&
        typeof desktopWindow.beginMove === "function" &&
        typeof desktopWindow.moveTo === "function" &&
        typeof desktopWindow.endMove === "function"
      );
      let pointerId = null;
      let startX = 0;
      let startY = 0;
      let originX = 0;
      let originY = 0;
      let dragging = false;
      let holdTimer = null;
      let suppressNextClick = false;

      function sendDesktopMove(action, point) {
        if (!canMoveDesktopWindow) return;
        desktopWindow[action](point).catch((error) => {
          console.warn(`desktopWindow.${action} failed.`, error);
        });
      }

      topbar.addEventListener("pointerdown", (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.target.closest(".no-drag, button, input, textarea, select, a")) return;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        originX = state.windowX;
        originY = state.windowY;
        if (canStartNativeDrag) {
          app.classList.add("is-dragging");
          desktopWindow.startDragging().catch((error) => {
            console.warn("desktopWindow.startDragging failed.", error);
          }).finally(() => {
            app.classList.remove("is-dragging");
          });
          return;
        }
        if (canMoveDesktopWindow) {
          sendDesktopMove("beginMove", { x: event.screenX, y: event.screenY });
        }
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => beginDrag(event), 160);
      });

      topbar.addEventListener("pointermove", (event) => {
        if (event.pointerId !== pointerId) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 4) beginDrag(event);
        if (!dragging) return;
        event.preventDefault();
        if (canMoveDesktopWindow) {
          sendDesktopMove("moveTo", { x: event.screenX, y: event.screenY });
        } else {
          state.windowX = originX + dx;
          state.windowY = originY + dy;
          applyWindowPosition();
        }
      });

      topbar.addEventListener("pointerup", endDrag);
      topbar.addEventListener("pointercancel", endDrag);

      topbar.addEventListener("click", (event) => {
        if (!suppressNextClick) return;
        event.preventDefault();
        event.stopPropagation();
        suppressNextClick = false;
      }, true);

      function beginDrag(event) {
        if (dragging || pointerId === null) return;
        dragging = true;
        suppressNextClick = true;
        app.classList.add("is-dragging");
        try {
          topbar.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture may be unavailable in older browser shells.
        }
      }

      function endDrag(event) {
        if (event.pointerId !== pointerId) return;
        clearTimeout(holdTimer);
        if (canMoveDesktopWindow) {
          sendDesktopMove("endMove");
        }
        if (dragging && !canMoveDesktopWindow) {
          saveAppState();
        }
        dragging = false;
        pointerId = null;
        app.classList.remove("is-dragging");
        try {
          topbar.releasePointerCapture(event.pointerId);
        } catch {
          // Matching release for the optional capture above.
        }
      }
    }

    function bindWindowResize() {
      const desktopWindow = window.desktopWindow;
      const canStartNativeResize = Boolean(
        desktopWindow &&
        desktopWindow.isDesktop &&
        typeof desktopWindow.startResizeDragging === "function"
      );
      const canResizeDesktopWindow = Boolean(
        desktopWindow &&
        desktopWindow.isDesktop &&
        typeof desktopWindow.beginResize === "function" &&
        typeof desktopWindow.resizeTo === "function" &&
        typeof desktopWindow.endResize === "function"
      );
      if (!canResizeDesktopWindow) return;

      const edges = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
      let pointerId = null;

      edges.forEach((edge) => {
        const handle = document.createElement("div");
        handle.className = `resize-handle resize-${edge}`;
        handle.dataset.edge = edge;
        app.appendChild(handle);

        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== undefined && event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          pointerId = event.pointerId;
          app.classList.add("is-resizing");
          if (canStartNativeResize) {
            desktopWindow.startResizeDragging(edge).catch((error) => {
              console.warn("desktopWindow.startResizeDragging failed.", error);
            }).finally(() => {
              pointerId = null;
              app.classList.remove("is-resizing");
            });
            return;
          }
          desktopWindow.beginResize(edge, { x: event.screenX, y: event.screenY }).catch((error) => {
            console.warn("desktopWindow.beginResize failed.", error);
          });
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture may be unavailable in older browser shells.
          }
        });

        handle.addEventListener("pointermove", (event) => {
          if (event.pointerId !== pointerId) return;
          event.preventDefault();
          desktopWindow.resizeTo({ x: event.screenX, y: event.screenY }).catch((error) => {
            console.warn("desktopWindow.resizeTo failed.", error);
          });
        });

        handle.addEventListener("pointerup", endResize);
        handle.addEventListener("pointercancel", endResize);

        function endResize(event) {
          if (event.pointerId !== pointerId) return;
          desktopWindow.endResize().catch((error) => {
            console.warn("desktopWindow.endResize failed.", error);
          });
          pointerId = null;
          app.classList.remove("is-resizing");
          try {
            handle.releasePointerCapture(event.pointerId);
          } catch {
            // Matching release for the optional capture above.
          }
        }
      });
    }

    async function loadAppState() {
      const externalStorage = window.noteStorage;
      if (externalStorage && typeof externalStorage.load === "function") {
        try {
          const externalData = await externalStorage.load();
          if (externalData) return externalData;
        } catch (error) {
          console.warn("noteStorage.load failed, fallback to localStorage.", error);
        }
      }

      const current = readJson(STORAGE_KEY);
      if (current) return current;

      const legacyState = readJson(LEGACY_STATE_KEY);
      if (legacyState) return legacyState;

      const legacyNotes = readJson(LEGACY_NOTES_KEY);
      const legacyTodos = readJson(LEGACY_TODOS_KEY);
      if (Array.isArray(legacyNotes) || Array.isArray(legacyTodos)) {
        return {
          ...structuredClone(defaultState),
          notes: Array.isArray(legacyNotes) ? legacyNotes : [],
          tasks: Array.isArray(legacyTodos) ? legacyTodos : []
        };
      }

      return structuredClone(defaultState);
    }

    async function saveAppState() {
      const persisted = stateForPersistence();
      const externalStorage = window.noteStorage;
      if (externalStorage && typeof externalStorage.save === "function") {
        try {
          await externalStorage.save(persisted);
          return;
        } catch (error) {
          console.warn("noteStorage.save failed, fallback to localStorage.", error);
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    }

    function readJson(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    function stateForPersistence() {
      return {
        ...state,
        editingNoteId: null,
        editingTaskId: null,
        draftNote: state.editingNoteId === "new" ? state.draftNote : { title: "", content: "" },
        notes: state.notes.filter((note) => note.title.trim() || note.content.trim()),
        tasks: state.tasks.filter((task) => task.content.trim())
      };
    }

    function normalizeState(input) {
      const next = { ...structuredClone(defaultState), ...(input || {}) };
      next.mode = next.mode === "tasks" ? "tasks" : "notes";
      next.taskView = next.taskView === "completed" ? "completed" : "pending";
      next.search = String(next.search || "");
      next.expandedNoteIds = Array.isArray(next.expandedNoteIds) ? next.expandedNoteIds : [];
      next.windowX = Number.isFinite(Number(next.windowX)) ? Number(next.windowX) : 0;
      next.windowY = Number.isFinite(Number(next.windowY)) ? Number(next.windowY) : 0;
      next.notes = Array.isArray(next.notes) ? next.notes.map(normalizeNote).filter(Boolean) : [];
      next.tasks = Array.isArray(next.tasks) ? next.tasks.map(normalizeTask).filter(Boolean) : [];
      next.notes.sort((a, b) => b.updatedAt - a.updatedAt);
      next.tasks.sort((a, b) => b.createdAt - a.createdAt);
      return next;
    }

    function normalizeNote(note) {
      if (!note || typeof note !== "object") return null;
      const createdAt = parseTime(note.createdAt || Date.now());
      return {
        id: String(note.id || createId()),
        title: String(note.title || "无标题"),
        content: String(note.content || ""),
        createdAt,
        updatedAt: parseTime(note.updatedAt || note.createdAt || createdAt)
      };
    }

    function normalizeTask(task) {
      if (!task || typeof task !== "object") return null;
      const content = String(task.content ?? task.text ?? "");
      const completed = Boolean(task.completed);
      const createdAt = parseTime(task.createdAt || Date.now());
      return {
        id: String(task.id || createId()),
        content,
        completed,
        createdAt,
        updatedAt: parseTime(task.updatedAt || task.createdAt || createdAt),
        completedAt: task.completedAt ? parseTime(task.completedAt) : completed ? parseTime(task.updatedAt || Date.now()) : null
      };
    }

    function parseTime(value) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : Date.now();
    }

    function createId() {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return crypto.randomUUID();
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function persistAndRender() {
      saveAppState();
      render();
    }

    function render() {
      renderChrome();
      renderContent();
    }

    function renderChrome() {
      stage.classList.toggle("app-closed", !state.visible);
      app.classList.toggle("is-pinned", state.pinned);
      applyWindowPosition();
      pinBtn.setAttribute("aria-pressed", String(state.pinned));
      pinBtn.title = state.pinned ? "取消置顶" : "置顶";

      document.querySelectorAll(".segment").forEach((button) => {
        const active = button.dataset.mode === state.mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });

      const noteIcon = document.querySelector(".note-tab-icon");
      if (noteIcon) {
        noteIcon.src = state.mode === "notes" ? "assets/images/notebook-W.svg" : "assets/images/notebook-B.svg";
      }

      searchInput.value = state.search;
      searchInput.placeholder = state.mode === "notes" ? "搜索笔记" : "搜索任务";
      createBtn.textContent = state.mode === "notes" ? "新建笔记" : "新建任务";
    }

    function applyWindowPosition() {
      app.style.setProperty("--window-x", `${state.windowX}px`);
      app.style.setProperty("--window-y", `${state.windowY}px`);
    }

    async function syncAlwaysOnTop() {
      const desktopWindow = window.desktopWindow;
      if (!desktopWindow || typeof desktopWindow.setAlwaysOnTop !== "function") return;
      try {
        state.pinned = await desktopWindow.setAlwaysOnTop(state.pinned);
      } catch (error) {
        console.warn("desktopWindow.setAlwaysOnTop failed.", error);
      }
    }

    function renderContent() {
      content.innerHTML = "";
      content.classList.toggle("is-task-content", state.mode === "tasks");
      if (state.mode === "notes") renderNotes();
      if (state.mode === "tasks") renderTasks();
    }

    function renderNotes() {
      if (state.editingNoteId === "new") {
        content.appendChild(createNoteEditor());
      }

      const list = document.createElement("div");
      list.className = "note-list";

      const notes = filteredNotes();
      notes.forEach((note) => {
        if (state.editingNoteId === note.id) {
          list.appendChild(createNoteEditor(note));
        } else {
          list.appendChild(createNoteCard(note));
        }
      });

      if (!notes.length && state.editingNoteId !== "new") {
        list.appendChild(createEmptyState(state.search ? "没有找到匹配的笔记" : "暂无笔记", "noteIcon"));
      }

      content.appendChild(list);
      focusEditorInput(".title-input");
    }

    function filteredNotes() {
      const query = state.search.trim().toLowerCase();
      return state.notes
        .filter((note) => !query || `${note.title} ${note.content}`.toLowerCase().includes(query))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    function createNoteEditor(note) {
      const existing = note || state.notes.find((item) => item.id === state.editingNoteId);
      const draft = existing || state.draftNote;

      const form = document.createElement("form");
      form.className = `note-editor${state.editingNoteId === "new" ? " is-tall" : ""}`;
      form.innerHTML = `
        <input class="title-input" name="title" maxlength="80" placeholder="笔记标题" value="${escapeAttr(draft.title || "")}">
        <textarea class="body-input" name="content" maxlength="4000" placeholder="开始记笔记...">${escapeHtml(draft.content || "")}</textarea>
        <div class="editor-actions">
          <button class="secondary-btn" type="button" data-action="cancel">取消</button>
          <button class="primary-btn" type="submit">${existing ? "保存" : "保存笔记"}</button>
        </div>
      `;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const rawTitle = String(formData.get("title") || "").trim();
        const noteContent = String(formData.get("content") || "").trim();

        if (!rawTitle && !noteContent) return;

        const title = rawTitle || "无标题";

        const now = Date.now();
        if (existing) {
          existing.title = title;
          existing.content = noteContent;
          existing.updatedAt = now;
        } else {
          state.notes.unshift({
            id: createId(),
            title,
            content: noteContent,
            createdAt: now,
            updatedAt: now
          });
        }

        state.editingNoteId = null;
        state.draftNote = { title: "", content: "" };
        persistAndRender();
      });

      form.querySelector('[data-action="cancel"]').addEventListener("click", () => {
        state.editingNoteId = null;
        state.draftNote = { title: "", content: "" };
        render();
      });

      form.querySelector('[name="title"]').addEventListener("input", (event) => {
        if (state.editingNoteId === "new") state.draftNote.title = event.target.value;
      });

      form.querySelector('[name="content"]').addEventListener("input", (event) => {
        if (state.editingNoteId === "new") state.draftNote.content = event.target.value;
      });

      return form;
    }

    function createNoteCard(note) {
      const expanded = state.expandedNoteIds.includes(note.id);
      const canExpand = note.content.length > 180 || note.content.includes("\n");
      const card = document.createElement("article");
      card.className = "note-card";
      card.tabIndex = 0;
      card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="note-time">${relativeTime(note.updatedAt)}</div>
            <h3 class="note-title">${escapeHtml(note.title)}</h3>
          </div>
          <div class="card-actions">
            <button class="text-icon" type="button" data-action="edit" title="编辑" aria-label="编辑笔记">${icon("editIcon")}</button>
            <button class="text-icon danger" type="button" data-action="delete" title="删除" aria-label="删除笔记">${icon("deleteIcon")}</button>
          </div>
        </div>
        <p class="note-body${canExpand && !expanded ? " collapsed" : ""}">${escapeHtml(note.content)}</p>
        ${canExpand ? `<button class="link-btn" type="button" data-action="expand">${expanded ? "收起" : "展开"}</button>` : ""}
      `;

      card.addEventListener("dblclick", (event) => {
        if (event.target.closest("button")) return;
        editNote(note.id);
      });

      card.querySelector('[data-action="edit"]').addEventListener("click", () => editNote(note.id));
      bindInlineDeleteConfirm(card.querySelector('[data-action="delete"]'), () => deleteNote(note.id));

      const expandButton = card.querySelector('[data-action="expand"]');
      if (expandButton) {
        expandButton.addEventListener("click", () => {
          toggleNoteExpanded(note.id);
          renderContent();
        });
      }

      return card;
    }

    function editNote(noteId) {
      state.editingNoteId = noteId;
      render();
    }

    function deleteNote(noteId) {
      state.notes = state.notes.filter((note) => note.id !== noteId);
      state.expandedNoteIds = state.expandedNoteIds.filter((id) => id !== noteId);
      if (state.editingNoteId === noteId) state.editingNoteId = null;
      persistAndRender();
    }

    function toggleNoteExpanded(noteId) {
      if (state.expandedNoteIds.includes(noteId)) {
        state.expandedNoteIds = state.expandedNoteIds.filter((id) => id !== noteId);
      } else {
        state.expandedNoteIds = [...state.expandedNoteIds, noteId];
      }
      saveAppState();
    }

    function renderTasks() {
      const board = document.createElement("section");
      board.className = "task-board";

      const query = state.search.trim().toLowerCase();
      const filteredTasks = state.tasks.filter((task) => !query || task.content.toLowerCase().includes(query));
      const pending = filteredTasks.filter((task) => !task.completed);
      const completed = filteredTasks.filter((task) => task.completed);
      const visibleTasks = state.taskView === "completed" ? completed : pending;
      const showingCompleted = state.taskView === "completed";

      if (!state.tasks.length && !state.search) {
        board.appendChild(createEmptyState("暂无待办事项", "taskIcon"));
      } else {
        board.appendChild(createTaskStatusTabs());
        board.appendChild(createTaskList(visibleTasks, showingCompleted));
      }

      content.appendChild(board);
      focusEditorInput(".task-row.editing .task-input");
    }

    function createTaskStatusTabs() {
      const tabs = document.createElement("div");
      tabs.className = "task-status-tabs";

      const pendingCount = state.tasks.filter((task) => !task.completed && task.content.trim()).length;
      const completedCount = state.tasks.filter((task) => task.completed && task.content.trim()).length;
      tabs.appendChild(createTaskStatusTab("pending", `待完成（${pendingCount}）`));
      tabs.appendChild(createTaskStatusTab("completed", `已完成（${completedCount}）`));
      return tabs;
    }

    function createTaskStatusTab(view, label) {
      const button = document.createElement("button");
      button.className = "task-status-tab";
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(state.taskView === view));
      button.addEventListener("click", () => {
        state.taskView = view;
        state.editingTaskId = null;
        persistAndRender();
      });
      return button;
    }

    function createTaskList(tasks, completed) {
      const list = document.createElement("div");
      list.className = "task-list";

      tasks
        .sort((a, b) => completed ? (b.completedAt || 0) - (a.completedAt || 0) : b.createdAt - a.createdAt)
        .forEach((task) => list.appendChild(createTaskRow(task)));

      if (!tasks.length && state.search) {
        list.appendChild(createEmptyState("没有匹配的任务", "taskIcon"));
      }

      return list;
    }

    function addBlankTask() {
      cleanupEmptyDraftTasks();
      const now = Date.now();
      const task = {
        id: createId(),
        content: "",
        completed: false,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      };
      state.mode = "tasks";
      state.taskView = "pending";
      state.search = "";
      state.tasks.unshift(task);
      state.editingTaskId = task.id;
    }

    function createTaskRow(task) {
      const row = document.createElement("div");
      row.className = `task-row${task.completed ? " completed" : ""}${state.editingTaskId === task.id ? " editing" : ""}`;

      if (state.editingTaskId === task.id) {
        row.innerHTML = `
          <button class="check${task.completed ? " is-checked" : ""}" type="button" aria-label="切换完成状态">${icon("checkIcon")}</button>
          <form class="task-edit-form">
            <input class="task-input" maxlength="120" value="${escapeAttr(task.content)}" placeholder="输入任务...">
          </form>
          <div class="task-actions">
            <button class="text-icon" type="button" data-action="save" title="保存" aria-label="保存任务">${icon("checkIcon")}</button>
            <button class="text-icon danger" type="button" data-action="delete" title="删除" aria-label="删除任务">${icon("deleteIcon")}</button>
          </div>
        `;

        const input = row.querySelector(".task-input");
        const form = row.querySelector(".task-edit-form");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          saveTaskEdit(task, input.value);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Escape") cancelTaskEdit(task);
        });
        row.querySelector('[data-action="save"]').addEventListener("click", () => saveTaskEdit(task, input.value));
      } else {
        row.innerHTML = `
          <button class="check" type="button" aria-label="${task.completed ? "取消完成" : "标记完成"}">${icon("checkIcon")}</button>
          <span class="task-text" title="${escapeAttr(task.content)}">${escapeHtml(task.content)}</span>
          <div class="task-actions">
            ${task.completed ? "" : `<button class="text-icon" type="button" data-action="edit" title="编辑" aria-label="编辑任务">${icon("editIcon")}</button>`}
            <button class="text-icon danger" type="button" data-action="delete" title="删除" aria-label="删除任务">${icon("deleteIcon")}</button>
          </div>
        `;

        row.addEventListener("dblclick", (event) => {
          if (event.target.closest("button")) return;
          editTask(task.id);
        });

        const editButton = row.querySelector('[data-action="edit"]');
        if (editButton) editButton.addEventListener("click", () => editTask(task.id));
      }

      row.querySelector(".check").addEventListener("click", () => toggleTask(task.id));
      bindInlineDeleteConfirm(row.querySelector('[data-action="delete"]'), () => deleteTask(task.id));
      return row;
    }

    function editTask(taskId) {
      state.editingTaskId = taskId;
      render();
    }

    function saveTaskEdit(task, value) {
      const next = value.trim();
      if (!next) {
        cancelTaskEdit(task);
        return;
      }
      task.content = next;
      task.updatedAt = Date.now();
      state.editingTaskId = null;
      persistAndRender();
    }

    function saveCurrentTaskEdit(options = {}) {
      const task = state.tasks.find((item) => item.id === state.editingTaskId);
      if (!task) return;

      const input = content.querySelector(".task-row.editing .task-input");
      const next = String(input ? input.value : task.content).trim();

      if (!next) {
        if (!task.content.trim()) {
          state.tasks = state.tasks.filter((item) => item.id !== task.id);
        }
      } else {
        task.content = next;
        task.updatedAt = Date.now();
      }

      state.editingTaskId = null;
      saveAppState();

      if (options.deferRender) {
        setTimeout(render, 0);
      } else {
        render();
      }
    }

    function cancelTaskEdit(task) {
      if (!task.content.trim()) {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
      }
      state.editingTaskId = null;
      persistAndRender();
    }

    function toggleTask(taskId) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return;
      const now = Date.now();
      task.completed = !task.completed;
      task.updatedAt = now;
      task.completedAt = task.completed ? now : null;
      if (state.editingTaskId === taskId && !task.content.trim()) {
        state.editingTaskId = null;
      }
      persistAndRender();
    }

    function deleteTask(taskId) {
      state.tasks = state.tasks.filter((task) => task.id !== taskId);
      if (state.editingTaskId === taskId) state.editingTaskId = null;
      persistAndRender();
    }

    function bindInlineDeleteConfirm(deleteButton, onConfirm) {
      deleteButton.classList.add("delete-confirm-anchor");
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (deleteButton.classList.contains("is-confirming")) {
          onConfirm();
          return;
        }

        closeInlineDeleteConfirms(deleteButton);
        deleteButton.classList.add("is-confirming");
        deleteButton.title = "确认删除";
        deleteButton.setAttribute("aria-label", "确认删除");
        deleteButton.focus();
      });
    }

    function closeInlineDeleteConfirms(exceptButton = null) {
      document.querySelectorAll(".delete-confirm-anchor.is-confirming").forEach((button) => {
        if (button === exceptButton) return;
        button.classList.remove("is-confirming");
        button.title = "删除";
        button.setAttribute("aria-label", "删除");
      });
    }

    function cleanupEmptyDraftTasks() {
      state.tasks = state.tasks.filter((task) => task.content.trim());
    }

    function createEmptyState(message, templateId) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = `
        <span class="empty-mark">${icon(templateId)}</span>
        <span>${escapeHtml(message)}</span>
      `;
      return empty;
    }

    function focusEditorInput(selector) {
      requestAnimationFrame(() => {
        const input = content.querySelector(selector);
        if (!input) return;
        input.focus();
        if (typeof input.setSelectionRange === "function") {
          const length = input.value.length;
          input.setSelectionRange(length, length);
        }
      });
    }

    function relativeTime(timestamp) {
      const diff = Math.max(0, Date.now() - timestamp);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diff < minute) return "刚刚";
      if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
      if (diff < day) return `${Math.floor(diff / hour)}小时前`;
      const days = Math.floor(diff / day);
      if (days === 1) return "昨天";
      if (days < 7) return `${days}天前`;
      return new Date(timestamp).toLocaleDateString("zh-CN");
    }

    function icon(templateId) {
      return document.getElementById(templateId).innerHTML;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replaceAll("\n", " ");
    }
