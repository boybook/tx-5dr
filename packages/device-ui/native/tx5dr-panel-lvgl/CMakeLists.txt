add_executable(tx5dr-panel-lvgl
  src/main.c
  ../common/tx5dr_ipc.c
  ../common/tx5dr_png.c
)
target_include_directories(tx5dr-panel-lvgl PRIVATE
  src
  ../common
  ../vendor/lvgl
  ../vendor/yyjson/src
)
target_link_libraries(tx5dr-panel-lvgl PRIVATE lvgl yyjson ZLIB::ZLIB Threads::Threads)
if(SDL2_FOUND)
  target_include_directories(tx5dr-panel-lvgl PRIVATE ${SDL2_INCLUDE_DIRS})
  target_link_libraries(tx5dr-panel-lvgl PRIVATE ${SDL2_LIBRARIES})
endif()
