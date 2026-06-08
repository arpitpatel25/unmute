{
  "targets": [
    {
      "target_name": "native_fn_listener",
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/listener.mm"],
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/AppKit.framework",
              "$(SDKROOT)/System/Library/Frameworks/Foundation.framework",
              "$(SDKROOT)/System/Library/Frameworks/ApplicationServices.framework"
            ]
          },
          "xcode_settings": {
            "OTHER_CFLAGS": ["-ObjC++"],
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_ENABLE_OBJC_ARC": "YES"
          }
        }, {
          "sources": ["src/stub.cc"]
        }]
      ]
    }
  ]
}
