// Lists on-screen windows owned by a pid as JSON: [{id,x,y,w,h,layer,alpha}]
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
var out: [[String: Any]] = []
for w in info where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  out.append(["id": w[kCGWindowNumber as String]!, "x": b["X"]!, "y": b["Y"]!, "w": b["Width"]!, "h": b["Height"]!,
              "layer": w[kCGWindowLayer as String]!, "alpha": w[kCGWindowAlpha as String]!])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
