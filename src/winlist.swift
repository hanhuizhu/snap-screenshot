// winsnap — window / accessibility hit-test helper for Snap.
//
// Long-lived process speaking newline-delimited JSON on stdin/stdout.
//
//   -> {"cmd":"windows"}
//   <- {"ok":true,"windows":[{"x":0,"y":25,"w":1440,"h":875,"owner":"Google Chrome","pid":1234}]}
//
//   -> {"cmd":"hit","x":420,"y":300,"selfPid":999}
//   <- {"ok":true,"rect":{"x":100,"y":80,"w":640,"h":400},"source":"ax","role":"AXButton","title":"Submit"}
//
//   -> {"cmd":"status"}
//   <- {"ok":true,"axTrusted":true}
//
//   -> {"cmd":"qrcode","text":"http://192.168.1.5:8731/ab12cd34/"}
//   <- {"ok":true,"png":"<base64 PNG>"}
//
// Coordinates are global Quartz display points (origin = top-left of the main
// display, y grows downward), which is the same space Electron's screen module
// reports, so the renderer only has to subtract its own display origin.

import Foundation
import ApplicationServices
import AppKit
import CoreImage

// MARK: - QR code

/// 用 CoreImage 生成二维码 PNG（base64）。不自己写编码器：Reed-Solomon + 掩码
/// 那套很容易出错，系统自带的更可靠。返回的是符号本身，静默区由调用方用留白补。
func qrCodePNG(_ text: String) -> String? {
    guard let data = text.data(using: .utf8),
          let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(data, forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let symbol = filter.outputImage else { return nil }

    // 放大到手机上扫得动的尺寸（最近邻，保持边缘锐利）
    let scale: CGFloat = 8
    let scaled = symbol.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

    let rep = NSCIImageRep(ciImage: scaled)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: NSBitmapImageRep.FileType.png,
                                          properties: [NSBitmapImageRep.PropertyKey: Any]()) else { return nil }
    return png.base64EncodedString()
}

// MARK: - output

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

// MARK: - accessibility helpers

func axAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success else { return nil }
    return ref
}

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    guard let v = axAttr(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    guard AXValueGetValue((v as! AXValue), .cgPoint, &p) else { return nil }
    return p
}

func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
    guard let v = axAttr(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    guard AXValueGetValue((v as! AXValue), .cgSize, &s) else { return nil }
    return s
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = axAttr(el, attr) else { return nil }
    return v as? String
}

/// Deepest accessibility element at the given global point, if Accessibility
/// permission has been granted to the responsible app.
func axHit(x: Double, y: Double, selfPid: pid_t) -> [String: Any]? {
    guard AXIsProcessTrusted() else { return nil }
    var el: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),
                                               Float(x), Float(y), &el)
    guard err == .success, let hit = el else { return nil }

    var pid: pid_t = 0
    AXUIElementGetPid(hit, &pid)
    if pid == selfPid { return nil }

    guard let pos = axPoint(hit, kAXPositionAttribute as String),
          let size = axSize(hit, kAXSizeAttribute as String),
          size.width >= 6, size.height >= 6,
          size.width.isFinite, size.height.isFinite,
          pos.x.isFinite, pos.y.isFinite
    else { return nil }

    // Skip absurd one-pixel-wide hairlines and off-screen junk.
    if size.width > 64000 || size.height > 64000 { return nil }

    var out: [String: Any] = [
        "x": Double(pos.x), "y": Double(pos.y),
        "w": Double(size.width), "h": Double(size.height),
        "source": "ax",
    ]
    if let role = axString(hit, kAXRoleAttribute as String) { out["role"] = role }
    if let title = axString(hit, kAXTitleAttribute as String), !title.isEmpty { out["title"] = title }
    if let desc = axString(hit, kAXDescriptionAttribute as String), !desc.isEmpty { out["desc"] = desc }
    return out
}

// MARK: - window list

func onScreenWindows(selfPid: pid_t) -> [[String: Any]] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var out: [[String: Any]] = []
    for w in list {                                   // front-to-back order
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let pid = w[kCGWindowOwnerPID as String] as? Int, pid != Int(selfPid) else { continue }
        guard let bd = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let x = (bd["X"] as? NSNumber)?.doubleValue ?? 0
        let y = (bd["Y"] as? NSNumber)?.doubleValue ?? 0
        let width = (bd["Width"] as? NSNumber)?.doubleValue ?? 0
        let height = (bd["Height"] as? NSNumber)?.doubleValue ?? 0
        guard width >= 40, height >= 40, width < 64000, height < 64000 else { continue }
        var item: [String: Any] = ["x": x, "y": y, "w": width, "h": height, "pid": pid]
        if let owner = w[kCGWindowOwnerName as String] as? String { item["owner"] = owner }
        out.append(item)
    }
    return out
}

// MARK: - main loop

setvbuf(stdout, nil, _IONBF, 0)

let myPid = getpid()
emit(["ok": true, "ready": true, "pid": Int(myPid), "axTrusted": AXIsProcessTrusted()])

var buffer = [UInt8]()
let delim: UInt8 = 0x0A

while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { break }                        // parent closed the pipe
    buffer.append(contentsOf: chunk)

    while let idx = buffer.firstIndex(of: delim) {
        let lineBytes = Array(buffer[0..<idx])
        buffer.removeSubrange(0...idx)
        guard !lineBytes.isEmpty else { continue }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(lineBytes)) as? [String: Any],
              let cmd = obj["cmd"] as? String else {
            emit(["ok": false, "error": "bad request"])
            continue
        }

        switch cmd {
        case "windows":
            emit(["ok": true, "windows": onScreenWindows(selfPid: myPid)])

        case "hit":
            let x = (obj["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (obj["y"] as? NSNumber)?.doubleValue ?? 0
            let selfPid = pid_t((obj["selfPid"] as? NSNumber)?.intValue ?? 0)
            let skipAX = (obj["skipAX"] as? NSNumber)?.boolValue ?? false

            if !skipAX, let hit = axHit(x: x, y: y, selfPid: selfPid) {
                emit(["ok": true, "rect": hit])
            } else {
                // Fall back to the frontmost window containing the point.
                var found: [String: Any]? = nil
                for w in onScreenWindows(selfPid: selfPid) {
                    let wx = (w["x"] as? Double) ?? 0
                    let wy = (w["y"] as? Double) ?? 0
                    let ww = (w["w"] as? Double) ?? 0
                    let wh = (w["h"] as? Double) ?? 0
                    if x >= wx - 0.5, x <= wx + ww + 0.5, y >= wy - 0.5, y <= wy + wh + 0.5 {
                        found = w
                        break
                    }
                }
                if var f = found {
                    f["source"] = "window"
                    emit(["ok": true, "rect": f])
                } else {
                    emit(["ok": true, "rect": NSNull()])
                }
            }

        case "status":
            emit(["ok": true, "axTrusted": AXIsProcessTrusted()])

        case "qrcode":
            let text = (obj["text"] as? String) ?? ""
            if text.isEmpty {
                emit(["ok": false, "error": "empty text"])
            } else if let png = qrCodePNG(text) {
                emit(["ok": true, "png": png])
            } else {
                emit(["ok": false, "error": "qr generation failed"])
            }

        case "quit":
            emit(["ok": true, "bye": true])
            exit(0)

        default:
            emit(["ok": false, "error": "unknown cmd"])
        }
    }
}
