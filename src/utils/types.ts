import {
  EditorPosition,
  MarkdownFileInfo,
} from 'obsidian'
import { ImageURL } from './utils/types'

export interface ImageURL {
  file: TFile | null;
  path: string;
  url?: string;
  note_path: string;
  start: EditorPosition;
  end: EditorPosition;
};
