import CoreTransferable
import PhotosUI
import SwiftUI
import Tauri
import UniformTypeIdentifiers

private struct CachedImage: Transferable {
  let url: URL
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("agentport-image-picker", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let target = directory.appendingPathComponent(UUID().uuidString)
      do {
        try FileManager.default.copyItem(at: received.file, to: target)
        return CachedImage(url: target)
      } catch {
        try? FileManager.default.removeItem(at: target)
        throw error
      }
    }
  }
}

private struct ImagePickerView: View {
  @State private var presented = false
  @State private var selection: PhotosPickerItem?
  let finish: (Result<URL?, Error>) -> Void

  var body: some View {
    Color.clear
      .photosPicker(isPresented: $presented, selection: $selection, matching: .images,
                    preferredItemEncoding: .current)
      .onAppear { presented = true }
      .onChange(of: selection) { item in
        guard let item else { return }
        Task {
          do {
            guard let image = try await item.loadTransferable(type: CachedImage.self) else {
              throw NSError(domain: "ImagePicker", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Unable to read this image."])
            }
            await MainActor.run { finish(.success(image.url)) }
          } catch {
            await MainActor.run { finish(.failure(error)) }
          }
        }
      }
      .onChange(of: presented) { visible in
        if !visible {
          DispatchQueue.main.async {
            if selection == nil { finish(.success(nil)) }
          }
        }
      }
  }
}

class ImagePickerPlugin: Plugin {
  private var pending: Invoke?
  private var picker: UIViewController?

  @objc public func pickImage(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard self.pending == nil else { invoke.reject("An image picker is already open."); return }
      guard let parent = self.manager.viewController else {
        invoke.reject("Unable to open the image picker."); return
      }
      self.pending = invoke
      let controller = UIHostingController(rootView: ImagePickerView { result in
        guard let pending = self.pending else { return }
        self.pending = nil
        self.picker?.dismiss(animated: false) {
          switch result {
          case .success(let url):
            if let url { pending.resolve(["path": url.path]) }
            else { pending.resolve(["path": NSNull()]) }
          case .failure(_): pending.reject("Unable to read the selected image.")
          }
        }
        self.picker = nil
      })
      controller.view.backgroundColor = .clear
      controller.modalPresentationStyle = .overFullScreen
      controller.isModalInPresentation = true
      self.picker = controller
      parent.present(controller, animated: false)
    }
  }
}

@_cdecl("init_plugin_image_picker")
func initPlugin() -> Plugin { ImagePickerPlugin() }
