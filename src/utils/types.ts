import {
  EditorPosition,
  MarkdownFileInfo,
  TFile
} from 'obsidian'

export interface ImageURL {
  file: TFile | null;
  path: string;
  url?: string;
  note_path: string;
  start: EditorPosition;
  end: EditorPosition;
};
