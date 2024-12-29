export default class DirectFileCopy extends ClipboardEvent {
  constructor(file: File) {
    const dt = new DataTransfer()
    dt.items.add(file)
    super('paste', { clipboardData: dt })
  }
}
