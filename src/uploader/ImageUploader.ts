export default interface Imageloader {
  upload(image: File, albumId?: string): Promise<string>
  download(ctx: MarkdownFileInfo, imageURL: ImageURL): Promise<string>
}
