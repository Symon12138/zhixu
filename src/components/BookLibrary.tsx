import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, BookMarked, BookOpen, Check, ChevronLeft, ChevronRight, FileText, Library, LoaderCircle, Search, Sparkles, Trash2, X } from "lucide-react";
import type { BookDocument, BookProgress, BookSourceLocation, BookStudySelection, BookSummary } from "../bookTypes";
import type { StudySession } from "../types";
import { importBook } from "../lib/bookImport";
import {
  deleteBook,
  getBook,
  getBookMigrationState,
  getBookOwnerEpoch,
  getBookProgress,
  getLocalBook,
  isCloudShelfEnabled,
  listBookSyncStates,
  listBooks,
  onBookMigrationChange,
  onBookOwnerChange,
  onBookSyncChange,
  retryBookMigration,
  retryBookSync,
  saveBook,
  saveBookProgress,
  type BookMigrationState,
  type BookSyncState,
} from "../lib/bookStorage";
import { Modal } from "./UI";
import "./BookLibrary.css";

export interface BookLibraryProps {
  sessions: StudySession[];
  location?: BookSourceLocation | null;
  onStudy: (book: BookDocument, selection: BookStudySelection) => void;
  onOpenSession: (session: StudySession) => void;
  onSaveNote: (content: string, title: string) => void;
}
const WINDOW_BLOCKS = 16;

/** 书架卡片的云端同步状态文案；只在登录且云端可用时展示。 */
const SYNC_COPY: Record<BookSyncState, { label: string; detail: string; color: string; retry: boolean }> = {
  ready: { label: "已同步", detail: "已保存在你的账户书架，换设备登录后也能找到。", color: "var(--primary)", retry: false },
  pending: { label: "同步中", detail: "已加入上传队列，正在等待上传到账户书架。", color: "var(--muted)", retry: false },
  uploading: { label: "同步中", detail: "正在上传到你的账户书架。", color: "var(--muted)", retry: false },
  failed: { label: "同步失败", detail: "上次上传没有成功，可重试同步；本机原书仍可阅读。", color: "var(--warm)", retry: true },
  local: { label: "未同步", detail: "仅保存在本机，可重试同步到账户书架。", color: "var(--warm)", retry: true },
};

/** 书架与同步状态一起读取，避免列表与徽标来自不同快照。 */
async function readShelfState(): Promise<{ items: BookSummary[]; states: Record<string, BookSyncState> }> {
  const items = await listBooks();
  const states = await listBookSyncStates();
  return { items, states };
}

/**
 * 书架卡片的云端同步徽标。云端独有的书没有本机摘要，按已同步展示；
 * 其余状态来自 listBookSyncStates / onBookSyncChange。
 */
function BookSyncBadge({ state, retrying, onRetry }: { state: BookSyncState; retrying: boolean; onRetry: () => void }) {
  const copy = SYNC_COPY[state];
  return (
    <small className="book-sync-state" style={{ color: copy.color }} title={copy.detail}>
      云端：{copy.label}
      {copy.retry && <> · <button type="button" className="text-button" disabled={retrying} onClick={onRetry}>{retrying ? "正在重新同步…" : "重试同步"}</button></>}
    </small>
  );
}

export function BookLibrary({ sessions, location, onStudy, onOpenSession, onSaveNote }: BookLibraryProps) {
  const [shelf, setShelf] = useState<BookSummary[]>([]);
  const [book, setBook] = useState<BookDocument | null>(null);
  const [progress, setProgress] = useState<BookProgress | null>(null);
  const [chapterId, setChapterId] = useState("");
  const [windowIndex, setWindowIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncStates, setSyncStates] = useState<Record<string, BookSyncState>>({});
  const [retryingSync, setRetryingSync] = useState<string | null>(null);
  const cloudEnabled = isCloudShelfEnabled();
  // 上传失败（例如 401）后 isCloudShelfEnabled 会转 false；只要本次会话有非 local 状态，
  // 仍展示徽标，避免“同步失败”在重渲染后凭空消失。未登录的纯本机书架不显示徽标。
  const showSyncBadges = cloudEnabled || Object.values(syncStates).some(state => state !== "local");
  const [migration, setMigration] = useState<BookMigrationState>(() => getBookMigrationState());
  const [retryingMigration, setRetryingMigration] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const importAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const loadVersion = useRef(0);
  const navigationVersion = useRef(0);
  const shelfVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const refresh = (resetReader: boolean) => {
      const version = ++shelfVersion.current;
      if (resetReader) {
        ++loadVersion.current;
        ++navigationVersion.current;
        setBook(null); setProgress(null); setChapterId(""); setHighlight(null); setQuery("");
        setDeleteTarget(null); setError(""); setNotice(""); setShelf([]); setSyncStates({});
      }
      setLoading(true);
      void readShelfState()
        .then(next => {
          if (!mounted.current || version !== shelfVersion.current) return;
          setShelf(next.items);
          setSyncStates(next.states);
        })
        .catch(cause => { if (mounted.current && version === shelfVersion.current) setError(cause instanceof Error ? cause.message : "无法打开本机书架"); })
        .finally(() => { if (mounted.current && version === shelfVersion.current) setLoading(false); });
    };
    refresh(false);
    const unsubscribeMigration = onBookMigrationChange(state => {
      if (!mounted.current) return;
      setMigration(state);
    });
    const unsubscribeSync = onBookSyncChange(event => {
      if (!mounted.current) return;
      setSyncStates(previous => previous[event.bookId] === event.state ? previous : { ...previous, [event.bookId]: event.state });
    });
    // 订阅前若已进入 blocked/failed/completed，补读一次，避免错过事件。
    setMigration(getBookMigrationState());
    const unsubscribeOwner = onBookOwnerChange(() => {
      importAbort.current?.abort();
      setMigration(getBookMigrationState());
      refresh(true);
    });
    return () => {
      mounted.current = false;
      unsubscribeMigration();
      unsubscribeSync();
      unsubscribeOwner();
      importAbort.current?.abort();
    };
  }, []);

  async function openBook(id: string, source?: BookSourceLocation) {
    const version = ++loadVersion.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const [loaded, saved] = await Promise.all([getBook(id), getBookProgress(id)]);
      if (!mounted.current || version !== loadVersion.current) return;
      if (!loaded) throw new Error("这本原书已不在本机或当前账户的云端书架。历史对话与引文仍保留，请重新导入同一原始文件后回看。");
      const nextChapter = source?.chapterId ?? saved?.chapterId ?? loaded.chapters[0]?.id;
      const chapter = loaded.chapters.find(item => item.id === nextChapter) ?? (source ? undefined : loaded.chapters[0]);
      if (!chapter) throw new Error("没有找到引文对应章节，请核对导入的书籍版本。");
      const targetBlock = source?.blockId ?? saved?.blockId;
      if (source && !chapter.blockIds.includes(source.blockId)) throw new Error("没有找到引文对应段落，未跳转到其它内容。请核对原书版本。");
      const blockIndex = targetBlock ? chapter.blockIds.indexOf(targetBlock) : 0;
      setBook(loaded); setChapterId(chapter.id); setQuery(""); setWindowIndex(Math.floor(Math.max(0, blockIndex) / WINDOW_BLOCKS));
      setHighlight(source?.blockId ?? null);
      setProgress(saved ?? { bookId: id, chapterId: chapter.id, readChapterIds: [], updatedAt: Date.now() });
    } catch (cause) {
      if (mounted.current && version === loadVersion.current) setError(cause instanceof Error ? cause.message : "读取书籍失败，原文件未改变。");
    } finally { if (mounted.current && version === loadVersion.current) setLoading(false); }
  }

  useEffect(() => { if (location) void openBook(location.bookId, location); }, [location]);
  useEffect(() => {
    if (!highlight || !book) return;
    const frame = requestAnimationFrame(() => {
      const block = document.getElementById(`source-${highlight}`);
      block?.scrollIntoView({ block: "center", behavior: "instant" });
      block?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [book, chapterId, windowIndex, highlight]);

  const chapter = book?.chapters.find(item => item.id === chapterId);
  const chapterIndex = book?.chapters.findIndex(item => item.id === chapterId) ?? -1;
  const blockMap = useMemo(() => new Map(book?.blocks.map(block => [block.id, block]) ?? []), [book]);
  const chapterBlocks = useMemo(() => chapter?.blockIds.map(id => blockMap.get(id)).filter((block): block is BookDocument["blocks"][number] => !!block) ?? [], [chapter, blockMap]);
  const matchingBlocks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? chapterBlocks.filter(block => block.text.toLocaleLowerCase().includes(search)) : chapterBlocks;
  }, [chapterBlocks, query]);
  const windowCount = Math.max(1, Math.ceil(matchingBlocks.length / WINDOW_BLOCKS));
  const currentWindow = Math.min(windowIndex, windowCount - 1);
  const visibleBlocks = matchingBlocks.slice(currentWindow * WINDOW_BLOCKS, (currentWindow + 1) * WINDOW_BLOCKS);
  const relatedSessions = sessions.filter(session => session.bookContext?.bookId === book?.id);

  async function persist(next: BookProgress) {
    const version = ++navigationVersion.current;
    try {
      await saveBookProgress(next);
      if (mounted.current && version === navigationVersion.current) { setProgress(next); setNotice(""); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "阅读位置未保存，请勿关闭页面。"); }
  }
  function goChapter(id: string) {
    if (!book || !book.chapters.some(item => item.id === id)) return;
    setChapterId(id); setQuery(""); setWindowIndex(0); setHighlight(null);
    void persist({ bookId: book.id, chapterId: id, readChapterIds: progress?.readChapterIds ?? [], updatedAt: Date.now() });
  }
  function goWindow(index: number) {
    if (!book || !chapter || index < 0 || index >= windowCount) return;
    setWindowIndex(index); setHighlight(null);
    const target = matchingBlocks[index * WINDOW_BLOCKS];
    void persist({ bookId: book.id, chapterId: chapter.id, ...(target ? { blockId: target.id } : {}), readChapterIds: progress?.readChapterIds ?? [], updatedAt: Date.now() });
    document.getElementById("book-reader-title")?.focus();
  }
  /** 导入/删除完成后刷新书架与同步徽标；刷新失败不改变已经完成的本地操作。 */
  async function refreshShelfQuietly() {
    const epoch = getBookOwnerEpoch();
    try {
      const next = await readShelfState();
      if (!mounted.current || epoch !== getBookOwnerEpoch()) return;
      setShelf(next.items);
      setSyncStates(next.states);
    } catch {
      /* 下次进入书架或账号切换时会重新读取，不覆盖当前列表。 */
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || importing) return;
    const controller = new AbortController(); importAbort.current = controller;
    const ownerEpoch = getBookOwnerEpoch();
    setImporting(true); setError(""); setNotice("");
    try {
      const imported = await importBook(file, message => { if (mounted.current) setImportStatus(message); }, controller.signal);
      controller.signal.throwIfAborted();
      if (ownerEpoch !== getBookOwnerEpoch()) throw new Error("账号已切换，本次导入未保存。请重新导入。");
      const existing = await getLocalBook(imported.id);
      // getLocalBook 是异步的：期间切换账号后 saveBook 会写进新账户库。
      if (ownerEpoch !== getBookOwnerEpoch()) throw new Error("账号已切换，本次导入未保存。请重新导入。");
      await saveBook(imported, { expectedOwnerEpoch: ownerEpoch });
      if (!mounted.current || ownerEpoch !== getBookOwnerEpoch()) return;
      ++shelfVersion.current;
      await refreshShelfQuietly();
      await openBook(imported.id);
      if (mounted.current) setNotice(existing ? "这本书已经在书架中，已保留原书和阅读位置。" : cloudEnabled ? "已在本机导入，正在同步到你的账户书架；尚未向模型发送书籍内容。" : "已在本机导入。尚未向模型发送书籍内容。");
    } catch (cause) {
      if (mounted.current) {
        if (cause instanceof Error && cause.name === "AbortError") setNotice("已取消导入，没有保存不完整书籍。");
        else setError(cause instanceof Error ? cause.message : "导入失败，原文件未改变。");
      }
    } finally { if (mounted.current) { setImporting(false); setImportStatus(""); } importAbort.current = null; }
  }
  async function removeBook() {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true); setError("");
    try {
      await deleteBook(target.id);
      if (!mounted.current) return;
      if (book?.id === target.id) { setBook(null); setProgress(null); }
      ++shelfVersion.current;
      await refreshShelfQuietly();
      setDeleteTarget(null);
      setNotice(cloudEnabled ? "已从本机与云端书架删除这本原书和阅读位置；学习对话、引文与笔记仍保留。" : "已删除这本原书和阅读位置；学习对话、引文与笔记仍保留。");
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "删除失败，书籍未移除。"); }
    finally { if (mounted.current) setDeleting(false); }
  }
  async function retrySync(id: string) {
    if (retryingSync) return;
    setRetryingSync(id); setError("");
    try {
      await retryBookSync(id);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "重新同步失败，请稍后再试。");
    } finally {
      if (mounted.current) setRetryingSync(null);
    }
  }
  async function retryMigration() {
    if (retryingMigration) return;
    setRetryingMigration(true); setError("");
    try {
      const state = await retryBookMigration();
      if (!mounted.current) return;
      // 成功迁移会在 sink.notify 时通过 onBookOwnerChange 触发书架刷新。
      setMigration(state);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "书架迁移重试失败，请稍后再试。");
    } finally {
      if (mounted.current) setRetryingMigration(false);
    }
  }
  function study(selection: BookStudySelection) {
    if (!book || !chapter) return;
    void persist({ bookId: book.id, chapterId: chapter.id, ...(selection.blockId ? { blockId: selection.blockId } : {}), readChapterIds: progress?.readChapterIds ?? [], updatedAt: Date.now() });
    onStudy(book, selection);
  }

  return (
    <div className="book-library">
      <input ref={input} className="sr-only" type="file" accept=".pdf,.epub,.txt,.md,.markdown" aria-label="导入本地书籍文件" onChange={upload} tabIndex={-1} />
      <header className="book-library-heading">
        <div><span className="eyebrow">READ WITH THE SOURCE</span><h1>{book ? "把原文，读成自己的理解。" : "一本书，一条理解的路径。"}</h1><p>{cloudEnabled ? "原书同步到你的账户 · 逐章阅读 · 讲解可回看出处" : "原书留在本机 · 逐章阅读 · 讲解可回看出处"}</p></div>
        <button className="button primary" disabled={importing || loading} onClick={() => input.current?.click()}><BookOpen size={17} aria-hidden="true" />导入书籍</button>
      </header>
      {(migration.status === "blocked" || migration.status === "failed") && <div className="book-feedback book-error" role="alert">
        <p>{migration.status === "blocked" ? "匿名书架迁移被其他标签页阻止，尚未完成；书籍仍保存在本机匿名书架。请关闭其他知序标签页后重试。" : `匿名书架迁移未完成，书籍仍保存在本机匿名书架。重试不会删除原书。${migration.error ? `（${migration.error}）` : ""}`}</p>
        <button className="button secondary" disabled={retryingMigration} onClick={() => void retryMigration()}>{retryingMigration ? "正在重试迁移…" : "重试迁移书架"}</button>
      </div>}
      {error && <div className="book-feedback book-error" role="alert"><p>{error}</p><button className="icon-button" aria-label="关闭书籍错误" onClick={() => setError("")}><X size={17} /></button></div>}
      {notice && <div className="book-feedback" role="status"><Check size={16} aria-hidden="true" /><p>{notice}</p></div>}
      {importing && <div className="book-import-progress" role="status"><LoaderCircle size={19} className="spin" aria-hidden="true" /><p>{importStatus || "正在本机解析…"}</p><button className="text-button" onClick={() => importAbort.current?.abort()}>取消导入</button></div>}
      {loading && <div className="book-loading" role="status"><LoaderCircle className="spin" size={24} aria-hidden="true" /><p>正在读取书架…</p></div>}
      {!book && !loading && (
        <>
          <section className="book-import-info"><FileText size={21} aria-hidden="true" /><div><strong>支持 PDF 文本层、EPUB、TXT 与 Markdown</strong><p>最大30MiB、正文200万字符。扫描件请先做OCR，加密/DRM书籍需使用你有权读取的未加密文件。导入不调用AI；登录状态下只会把原书同步到你的账户书架。</p></div></section>
          {shelf.length ? <div className="book-shelf-grid">{shelf.map(item => <article className="book-card" key={item.id}>
            <div className="book-cover"><BookOpen size={35} strokeWidth={1.2} aria-hidden="true" /><span>{item.format.toUpperCase()}</span></div>
            <div className="book-card-body"><h2>{item.title}</h2><p>{item.author || "作者未注明"}</p><small>{item.chapterCount} 节 · {item.blockCount} 段 · {item.characters.toLocaleString()} 字符</small>{showSyncBadges && <BookSyncBadge state={syncStates[item.id] ?? "ready"} retrying={retryingSync === item.id} onRetry={() => void retrySync(item.id)} />}{!!item.warnings.length && <p className="book-warning-count">有 {item.warnings.length} 条解析提示</p>}<div className="book-card-actions"><button className="button secondary" onClick={() => void openBook(item.id)}>打开阅读<ArrowRight size={15} aria-hidden="true" /></button><button className="icon-button" aria-label={`删除书籍 ${item.title}`} onClick={() => setDeleteTarget(item)}><Trash2 size={16} /></button></div></div>
          </article>)}</div> : <div className="book-empty"><span className="book-empty-icon"><Library size={44} strokeWidth={1.2} aria-hidden="true" /></span><h2>先把一本想读的书，放进来。</h2><p>保留作者的原话，也留下自己的疑问。<br />不用先读完，不用先懂术语。</p><button className="button secondary" onClick={() => input.current?.click()} disabled={importing}>选择本机文件</button></div>}
        </>
      )}
      {book && chapter && !loading && (
        <div className="book-reading-layout">
          <aside className="book-contents" aria-label="书籍目录">
            <button className="text-button" onClick={() => { ++loadVersion.current; setBook(null); setHighlight(null); setQuery(""); }}><ArrowLeft size={15} aria-hidden="true" />返回书架</button>
            <h2>{book.title}</h2><p>{book.author || "作者未注明"} · {book.format.toUpperCase()}</p>
            <div className="book-reading-stat">已读 {progress?.readChapterIds.length ?? 0}/{book.chapters.length} 节<span>仅记录阅读，不认证掌握</span></div>
            <label className="book-mobile-chapters">当前章节<select value={chapter.id} onChange={event => goChapter(event.target.value)} aria-label="选择书籍章节">{book.chapters.map(item => <option key={item.id} value={item.id}>{item.title}{progress?.readChapterIds.includes(item.id) ? " · 已读" : ""}</option>)}</select></label>
            <nav className="book-chapter-list" aria-label="章节列表">{book.chapters.map((item, index) => <button key={item.id} className={item.id === chapter.id ? "active" : ""} aria-current={item.id === chapter.id ? "true" : undefined} onClick={() => goChapter(item.id)}><span>{String(index + 1).padStart(2, "0")}</span><span>{item.title}</span>{progress?.readChapterIds.includes(item.id) && <Check size={14} aria-label="已读" />}</button>)}</nav>
            <button className="button secondary book-download" onClick={() => { const url = URL.createObjectURL(book.original); const link = document.createElement("a"); link.href = url; link.download = book.fileName; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }}><ArrowDownToLine size={15} aria-hidden="true" />下载原文件</button>
          </aside>
          <section className="book-reader" aria-label="书籍原文阅读">
            <header className="book-reader-heading"><div><span className="eyebrow">ORIGINAL TEXT</span><h2 id="book-reader-title" tabIndex={-1}>{chapter.title}</h2><p>{chapterBlocks.length} 段原文 · 引用位置来自导入文件，不代表事实认证</p></div><button className="button secondary" onClick={() => { const read = progress?.readChapterIds ?? []; const next = read.includes(chapter.id) ? read.filter(id => id !== chapter.id) : [...read, chapter.id]; void persist({ bookId: book.id, chapterId: chapter.id, readChapterIds: next, updatedAt: Date.now() }); }}><Check size={15} aria-hidden="true" />{progress?.readChapterIds.includes(chapter.id) ? "取消已读" : "标记已读"}</button></header>
            {!!book.warnings.length && <details className="book-parse-warnings"><summary>解析范围提示（{book.warnings.length}）</summary><ul>{book.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            <div className="book-study-actions"><button className="button primary" onClick={() => study({ mode: "chapter", chapterId: chapter.id })}><Sparkles size={16} aria-hidden="true" />陪我学这一章</button><button className="button secondary" onClick={() => study({ mode: "overview" })}>阅读导览</button><button className="button secondary" onClick={() => study({ mode: "review", chapterId: chapter.id })}>主动回忆</button></div>
            <p className="book-scope-note">陪读只发送本轮选定的最多20段、24000字符；长章请使用具体段落入口。导览仅基于目录与章节开头，不冒充通读全书。</p>
            <label className="book-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索当前章节原文" placeholder="在本章查找原文…" value={query} onChange={event => { setQuery(event.target.value); setWindowIndex(0); setHighlight(null); }} /></label>
            {query.trim() && <p className="book-search-count" role="status">本章找到 {matchingBlocks.length} 段匹配原文</p>}
            <div className="book-source-blocks">{visibleBlocks.map(block => <article id={`source-${block.id}`} tabIndex={-1} className={`book-source-block${highlight === block.id ? " highlighted" : ""}`} key={block.id}>
              <div className="book-block-locator"><span>{block.locator}</span>{highlight === block.id && <strong>引文原处</strong>}</div>
              <p>{block.text}</p>
              <div className="book-block-actions"><button className="text-button" onClick={() => study({ mode: "chapter", chapterId: chapter.id, blockId: block.id })}><Sparkles size={14} aria-hidden="true" />围绕此段学习</button><button className="text-button" onClick={() => onSaveNote(`# 《${book.title}》摘录\n\n> ${block.text.replace(/\n/g, "\n> ")}\n\n出处：${chapter.title} · ${block.locator}\n\n## 我的理解\n\n`, `《${book.title}》·${chapter.title}`)}><BookMarked size={14} aria-hidden="true" />摘录笔记</button></div>
            </article>)}</div>
            {!matchingBlocks.length && <p className="book-no-matches">本章没有匹配段落，试试其他词。</p>}
            <nav className="book-window-controls" aria-label="章节原文分页"><button className="button secondary" disabled={currentWindow === 0} onClick={() => goWindow(currentWindow - 1)}><ChevronLeft size={16} aria-hidden="true" />上一组</button><span>第 {currentWindow + 1}/{windowCount} 组 · 每组最多 {WINDOW_BLOCKS} 段</span><button className="button secondary" disabled={currentWindow + 1 >= windowCount} onClick={() => goWindow(currentWindow + 1)}>下一组<ChevronRight size={16} aria-hidden="true" /></button></nav>
            <nav className="book-adjacent-chapters" aria-label="相邻章节"><button className="text-button" disabled={chapterIndex <= 0} onClick={() => goChapter(book.chapters[chapterIndex - 1].id)}><ChevronLeft size={16} aria-hidden="true" />上一章</button><button className="text-button" disabled={chapterIndex + 1 >= book.chapters.length} onClick={() => goChapter(book.chapters[chapterIndex + 1].id)}>下一章<ChevronRight size={16} aria-hidden="true" /></button></nav>
            {!!relatedSessions.length && <section className="book-related-sessions"><h3>这本书的学习记录</h3>{relatedSessions.slice(0, 12).map(session => <button key={session.id} onClick={() => onOpenSession(session)}><BookOpen size={16} aria-hidden="true" /><span>{session.title}<small>{session.bookContext?.chapterTitle ?? "目录导览"} · {session.messages.filter(message => message.role === "assistant").length} 条讲解</small></span><ArrowRight size={16} aria-hidden="true" /></button>)}</section>}
          </section>
        </div>
      )}
      <footer className="book-library-footer">{cloudEnabled ? "原书会同步到你的账户，可在其他设备读取；阅读进度仍只保存在本机。清理网站数据会丢失本机缓存，请保留原书。" : "书籍与原文件仅存当前浏览器 IndexedDB；清理网站数据会丢失，请保留原书。"}<a href="/book-credits.txt" target="_blank" rel="noopener noreferrer">教学方法与解析依赖来源</a></footer>
      {deleteTarget && <Modal title="删除这本书？" subtitle={`《${deleteTarget.title}》的原文件、正文与阅读进度会从${cloudEnabled ? "本机及云端" : "本机"}书架删除；已有学习对话、引用与笔记不删除。`} onClose={() => { if (!deleting) setDeleteTarget(null); }}><div className="modal-actions"><button className="button secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>保留原书</button><button className="button danger" disabled={deleting} onClick={() => void removeBook()}>{deleting ? "正在删除…" : "确认删除书籍"}</button></div></Modal>}
    </div>
  );
}
