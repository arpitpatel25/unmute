{
  "targets": [
    {
      "target_name": "native_ax",
      "conditions": [
        ['OS=="mac"', {
          "sources": ["src/ax.mm"],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "ApplicationServices",
              "-framework", "Cocoa",
              "-framework", "CoreGraphics",
              "-framework", "Foundation",
              "-weak_framework", "ScreenCaptureKit"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "OTHER_CFLAGS": ["-ObjC++"]
          }
        }],
        ['OS!="mac"', {
          "sources": ["src/stub.cc"]
        }]
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ]
    }
  ]
}
