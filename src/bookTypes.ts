export type BookFormat = "pdf" | "epub" | "txt" | "md";

/** Plain text only. Imported markup is never inserted into the application DOM. */
export interface BookBlock {
  id: string;
  chapterId: string;
  text: string;
  locator: string;
  page?: number;
}

export interface BookChapter {
  id: string;
  title: string;
  blockIds: string[];
}

export interface BookDocument {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  fileName: string;
  byteLength: number;
  sha256: string;
  importedAt: number;
  chapters: BookChapter[];
  blocks: BookBlock[];
  warnings: string[];
  pageCount?: number;
  original: Blob;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  fileName: string;
  byteLength: number;
  importedAt: number;
  chapterCount: number;
  blockCount: number;
  characters: number;
  warnings: string[];
  pageCount?: number;
}

/** 可跨设备传输的书目元数据；原文件二进制单独传输。 */
export type BookMetadata = Omit<BookDocument, "original">;

export interface CloudBookSummary extends BookSummary {
  updatedAt: number;
}

export interface BookProgress {
  bookId: string;
  chapterId: string;
  blockId?: string;
  readChapterIds: string[];
  updatedAt: number;
}

export interface BookSourceLocation {
  bookId: string;
  chapterId: string;
  blockId: string;
  chapterTitle: string;
  locator: string;
  page?: number;
}

/** Coverage describes supplied source text, not reading progress or mastery. */
export interface BookStudyContext {
  bookId: string;
  title: string;
  author: string;
  format: BookFormat;
  mode: "chapter" | "overview" | "review";
  chapterId?: string;
  chapterTitle?: string;
  tableOfContents: string[];
  totalChapters: number;
  totalBlocks: number;
  chapterBlocks: number;
  suppliedBlockIds: string[];
  completeChapter: boolean;
  completeBook: boolean;
}

export interface BookStudySelection {
  mode: BookStudyContext["mode"];
  chapterId?: string;
  blockId?: string;
}
