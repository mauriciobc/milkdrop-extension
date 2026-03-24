project(
  'gnome-milkdrop',
  version: '0.1.0',
  license: 'GPL-2.0-or-later',
  meson_version: '>= 0.56.0'
)

has_c_compiler = add_languages('c', native: false, required: false)

uuid = 'milkdrop@mauriciobc.github.io'
schema_id = 'org.gnome.shell.extensions.milkdrop'

prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
extension_dir = join_paths(datadir, 'gnome-shell', 'extensions', uuid)

metadata_conf = configuration_data()
metadata_conf.set('uuid', uuid)
metadata_conf.set('schema_id', schema_id)
metadata_conf.set('url', 'https://github.com/mauriciobc/gnome-milkdrop')

configure_file(
  input: 'src/extension/metadata.json.in',
  output: 'metadata.json',
  configuration: metadata_conf,
  install: true,
  install_dir: extension_dir
)

extension_sources = files(
  'src/extension/audio.js',
  'src/extension/evaluator.js',
  'src/extension/extension.js',
  'src/extension/frame-state.js',
  'src/extension/gnomeShellOverride.js',
  'src/extension/ipc.js',
  'src/extension/monitor.js',
  'src/extension/mpris-watcher.js',
  'src/extension/perf.js',
  'src/extension/prefs.js',
  'src/extension/presets.js',
  'src/extension/preset-crash-quarantine.js',
  'src/extension/preset-probe-policy.js',
  'src/extension/windowTitle.js',
  'src/extension/wallpaper.js'
)

expr_sources = files(
  'src/extension/expr/compiler.js',
  'src/extension/expr/context.js',
  'src/extension/expr/custom-shapes.js',
  'src/extension/expr/custom-waves.js',
  'src/extension/expr/functions.js',
  'src/extension/expr/lexer.js',
  'src/extension/expr/parser.js',
  'src/extension/expr/per-frame.js',
  'src/extension/expr/per-pixel.js'
)

renderer_sources = files(
  'src/renderer/gl-bridge.js',
  'src/renderer/glarea.js',
  'src/renderer/ipc-client.js',
  'src/renderer/renderer.js'
)

if has_c_compiler
  c_compiler = meson.get_compiler('c')
  egl_dep = dependency('egl', required: false)
  epoxy_dep = dependency('epoxy', required: false)
  glib_dep = dependency('glib-2.0', required: false)
  gio_unix_dep = dependency('gio-unix-2.0', required: false)
  json_glib_dep = dependency('json-glib-1.0', required: false)
  math_dep = c_compiler.find_library('m', required: false)
  sysprof_dep = dependency('sysprof-capture-4', required: false)

  projectm_dep = dependency('projectM-4', required: true)
  has_cxx = add_languages('cpp', required: true, native: false)
  cxx_compiler = meson.get_compiler('cpp')
  stdcpp_dep = cxx_compiler.find_library('stdc++', required: true)

  gl_helper_deps = [egl_dep, epoxy_dep, glib_dep, gio_unix_dep, json_glib_dep, math_dep, projectm_dep, stdcpp_dep]
  gl_helper_c_args = []
  if sysprof_dep.found()
    gl_helper_deps += sysprof_dep
    gl_helper_c_args += '-DHAVE_SYSPROF=1'
  endif

  if egl_dep.found() and epoxy_dep.found() and glib_dep.found() and json_glib_dep.found() and gio_unix_dep.found()
    executable(
      'milkdrop-gl-helper',
      'src/renderer/gl-helper.c',
      dependencies: gl_helper_deps,
      c_args: gl_helper_c_args,
      install: true,
      install_dir: join_paths(extension_dir, 'renderer')
    )
  else
    message('Skipping milkdrop-gl-helper build because EGL, epoxy, glib-2.0, gio-unix-2.0, or json-glib-1.0 is unavailable')
  endif
else
  message('Skipping milkdrop-gl-helper build because no C compiler is available')
endif

install_data(extension_sources, install_dir: extension_dir)
install_data(
  'src/shared/ipc-protocol.js',
  install_dir: join_paths(extension_dir, 'shared'),
)
install_data(
  'src/extension/preset-loader-process.js',
  'src/extension/milk-parser.js',
  install_dir: join_paths(extension_dir, 'extension'),
)
install_data(expr_sources, install_dir: join_paths(extension_dir, 'expr'))
install_data(expr_sources, install_dir: join_paths(extension_dir, 'extension', 'expr'))
install_data(renderer_sources, install_dir: join_paths(extension_dir, 'renderer'))
install_data(
  'src/extension/schemas/@0@.gschema.xml'.format(schema_id),
  install_dir: join_paths(extension_dir, 'schemas')
)

# Unit tests (GJS)
gjs = find_program('gjs', required: false)
if gjs.found()
  test(
    'unit-tests',
    gjs,
    args: ['-m', 'tests/run.js'],
    workdir: meson.project_source_root(),
  )
  benchmark(
    'perf',
    gjs,
    args: ['-m', 'tests/bench/run.js', '--', '--json'],
    workdir: meson.project_source_root(),
  )
else
  message('GJS not found; unit tests will not be run')
endif
