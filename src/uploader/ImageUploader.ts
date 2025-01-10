import { MarkdownFileInfo } from 'obsidian'
import { ImageURL } from '../utils/types'
export default interface Imageloader {
  upload(image: File, notePath?: string, albumId?: string): Promise<string>
  download(ctx: MarkdownFileInfo, imageURL: ImageURL): Promise<string>
}
