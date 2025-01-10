import {
  EditorPosition,
  MarkdownFileInfo,
  TFile
} from 'obsidian'

export interface ImageURL {
  file: TFile | null;
  path: string;
  url?: string;
  notePath: string;
  start: EditorPosition;
  end: EditorPosition;
};
