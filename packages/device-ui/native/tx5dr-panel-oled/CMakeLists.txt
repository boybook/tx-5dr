add_executable(tx5dr-panel-oled
  src/main.cpp
  ../common/tx5dr_ipc.c
  ../common/tx5dr_png.c
)
target_include_directories(tx5dr-panel-oled PRIVATE ../common)
target_link_libraries(tx5dr-panel-oled PRIVATE ZLIB::ZLIB Threads::Threads)
if(SDL2_FOUND)
  target_include_directories(tx5dr-panel-oled PRIVATE ${SDL2_INCLUDE_DIRS})
  target_link_libraries(tx5dr-panel-oled PRIVATE ${SDL2_LIBRARIES})
endif()
