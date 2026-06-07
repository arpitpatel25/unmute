{
  "targets": [
    {
      "target_name": "native_paste",
      "conditions": [
        ['OS=="mac"', {
          "sources": ["src/paste.mm"],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "ApplicationServices",
              "-framework", "Carbon",
              "-framework", "Foundation"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "OTHER_CFLAGS": ["-ObjC++"]
          }
        }],
        ['OS!="mac"', {
          # Non-mac platforms: stub. The .node still loads but every
          # function returns ok=false with a clear reason. Lets clipboard.ts
          # treat absence and unavailability identically.
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
