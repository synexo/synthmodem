{
  "targets": [
    {
      "target_name": "win_timer_resolution",
      "sources": [ "win_timer_resolution.cc" ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [ "-lwinmm" ]
        }]
      ]
    }
  ]
}
