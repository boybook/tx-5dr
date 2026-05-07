add_executable(tx5dr-panel-lvgl
  src/main.c
  ../common/tx5dr_ipc.c
  ../common/tx5dr_png.c
)
target_include_directories(tx5dr-panel-lvgl PRIVATE ../common)
target_link_libraries(tx5dr-panel-lvgl PRIVATE ZLIB::ZLIB Threads::Threads)
if(SDL2_FOUND)
  target_include_directories(tx5dr-panel-lvgl PRIVATE ${SDL2_INCLUDE_DIRS})
  target_link_libraries(tx5dr-panel-lvgl PRIVATE ${SDL2_LIBRARIES})
endif()
