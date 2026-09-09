#!/usr/bin/env python3
"""Exercise the real debug build stanza with fake compilers; no App is installed."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
NAMES = ['agentport-host', 'agentport-remote-bridge', 'agentport-mosh-attach', 'agentport-connector']
# This is tauri-build's documented/implemented externalBin copy side effect.
CARGO = '''#!/usr/bin/env python3
import os,sys,shutil
from pathlib import Path
root=Path.cwd(); args=sys.argv[1:]
if args[args.index('-p')+1]=='agentport':
 for p in (root/'src-tauri/binaries').glob('*-test-host'):
  target=root/'target/debug'/p.name.removesuffix('-test-host')
  shutil.copyfile(p,target)
  if os.environ.get('TAMPER'):target.write_text('unexpected replacement')
else:
 explicit='--target' in args
 output=root/'target'/('test-host/debug' if explicit else 'debug');output.mkdir(parents=True,exist_ok=True)
 for name in ['agentport-host','agentport-remote-bridge','agentport-mosh-attach','agentport-connector']:
  p=output/name
  # Reproduce Cargo Fresh trusting a top-level artifact overwritten by Tauri.
  if not explicit and os.environ.get('CARGO_FRESH') and p.exists():continue
  p.write_text('current '+name)
'''


class SidecarBuildTests(unittest.TestCase):
    def run_build(self, fresh=False, tamper=False):
        with tempfile.TemporaryDirectory(prefix='agentport-sidecars-test-') as directory:
            root=Path(directory)
            for path in ['src','src-tauri/scripts','src-tauri/binaries','target/debug','tools']:(root/path).mkdir(parents=True)
            shutil.copyfile(ROOT/'src-tauri/scripts/build-sidecar.sh',root/'src-tauri/scripts/build-sidecar.sh')
            for name in NAMES:
                (root/'src-tauri/binaries'/f'{name}-test-host').write_text('stale '+name)
                (root/'target/debug'/name).write_text('stale '+name)
            for name,body in [('cargo',CARGO),('npm','#!/bin/sh\nexit 0\n'),('rustc','#!/bin/sh\necho "host: test-host"\n')]:
                p=root/'tools'/name;p.write_text(body);p.chmod(0o755)
            script=(ROOT/'scripts/rebuild-debug-app.sh').read_text()
            start=script.index('(cd "$ROOT/src" && npm run build)')
            end=script.index('if ! grep -Fq "$DEBUG_BUNDLE_ID"',start)
            env=dict(os.environ,ROOT=str(root),DEBUG_BUNDLE_ID='test',PATH=str(root/'tools')+os.pathsep+os.environ['PATH'])
            if fresh:env['CARGO_FRESH']='1'
            if tamper:env['TAMPER']='1'
            result=subprocess.run(['bash','-eu','-c',script[start:end]],env=env,capture_output=True,text=True)
            content={name:(root/'target/debug'/name).read_text() for name in NAMES}
            return result,content

    def test_gui_copy_uses_current_sidecars_not_stale_inputs(self):
        result,content=self.run_build()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(content,{name:'current '+name for name in NAMES})

    def test_contaminated_cargo_fresh_outputs_are_not_reused(self):
        result,content=self.run_build(fresh=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(content,{name:'current '+name for name in NAMES})

    def test_unexpected_gui_replacement_fails_before_bundle_install(self):
        result,_=self.run_build(tamper=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('refusing to install a mixed bundle',result.stderr)


if __name__=='__main__':unittest.main()
