export interface CodeCommentRange {
  startLine: number;
  endLine: number;
}

export interface CodeCommentPreview extends CodeCommentRange {
  id: string;
  sourcePath?: string;
  sourceTitle: string;
  selectedText: string;
  comment: string;
}
