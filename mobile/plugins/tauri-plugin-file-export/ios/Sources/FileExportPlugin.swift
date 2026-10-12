import Tauri
import UIKit

private struct ExportArgs: Decodable {
  let path: String
  let name: String
  let jobId: String
}

class FileExportPlugin: Plugin, UIDocumentPickerDelegate {
  private var pending: Invoke?
  private var picker: UIDocumentPickerViewController?

  @objc public func exportFile(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(ExportArgs.self)
      DispatchQueue.main.async {
        guard self.pending == nil else { invoke.resolve(["status": "save_busy"]); return }
        let source = URL(fileURLWithPath: args.path).resolvingSymlinksInPath()
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
          .appendingPathComponent("agentport-file-downloads", isDirectory: true).resolvingSymlinksInPath()
        guard source.lastPathComponent == args.name,
              source.deletingLastPathComponent().lastPathComponent == args.jobId,
              source.deletingLastPathComponent().deletingLastPathComponent() == root,
              FileManager.default.fileExists(atPath: source.path),
              let parent = self.manager.viewController else {
          invoke.resolve(["status": "save_failed"]); return
        }
        // The private source already has the original name. The system owns
        // renaming/replacement prompts; never manually overwrite a destination.
        let controller = UIDocumentPickerViewController(forExporting: [source], asCopy: true)
        controller.delegate = self
        self.pending = invoke
        self.picker = controller
        parent.present(controller, animated: true)
      }
    } catch {
      invoke.resolve(["status": "save_failed"])
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(urls.isEmpty ? "save_failed" : "saved")
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish("cancelled")
  }
  private func finish(_ status: String) {
    let invoke = pending
    pending = nil
    picker = nil
    invoke?.resolve(["status": status])
  }
}

@_cdecl("init_plugin_file_export")
func initPlugin() -> Plugin { FileExportPlugin() }
