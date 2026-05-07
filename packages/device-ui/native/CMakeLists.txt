cmake_minimum_required(VERSION 3.18)
project(tx5dr_device_ui_native C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(TX5DR_DEVICE_UI_WITH_SDL "Build SDL preview backends when SDL2 is available" ON)

find_package(ZLIB REQUIRED)
find_package(Threads REQUIRED)

if(TX5DR_DEVICE_UI_WITH_SDL)
  find_package(SDL2 QUIET)
  if(SDL2_FOUND)
    add_compile_definitions(TX5DR_HAS_SDL=1)
    message(STATUS "SDL2 found: enabling SDL preview windows")
  else()
    message(STATUS "SDL2 not found: SDL backends will use PNG/log fallback")
  endif()
endif()

add_subdirectory(tx5dr-panel-lvgl)
add_subdirectory(tx5dr-panel-oled)
