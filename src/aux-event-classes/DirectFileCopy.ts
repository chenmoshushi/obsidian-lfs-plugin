export default class DirectFileCopy extends ClipboardEvent {
  constructor(files: FileList) {
    const dt = new DataTransfer()
    for (const file of files) {
      dt.items.add(file)
    }
    super('paste', { clipboardData: dt })
  }
}
