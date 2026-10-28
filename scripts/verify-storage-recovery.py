#!/usr/bin/env python3
"""Exercise real systemd recovery with isolated user units, never production mounts."""
import json, os, pathlib, subprocess, time, uuid
base=pathlib.Path('var/qa').resolve()/('storage-recovery-'+uuid.uuid4().hex)
base.mkdir(parents=True,mode=0o700)
prefix='donarium-boot-qa-'+uuid.uuid4().hex
app=prefix+'-app.service';gate=prefix+'-gate.service';retry=prefix+'-retry.service'
ready=base/'storage-ready';started=base/'app-started'
def run(*args,check=True):return subprocess.run(['systemctl','--user',*args],check=check,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def until(check,seconds=15):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if check():return
  time.sleep(.2)
 raise RuntimeError('Isolated systemd recovery timed out')
(base/gate).write_text(f'[Unit]\nOnFailure={retry}\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nExecStart=/usr/bin/test -e {ready}\nRemainAfterExit=yes\n')
(base/app).write_text(f'[Unit]\nRequires={gate}\nBindsTo={gate}\nAfter={gate}\n[Service]\nType=oneshot\nExecStart=/usr/bin/touch {started}\nRemainAfterExit=yes\n[Install]\nWantedBy=default.target\n')
source=pathlib.Path('deploy/storage/donarium-storage-recover.service').read_text()
source=source.replace('donarium.service',app).replace('/usr/bin/systemctl ','/usr/bin/systemctl --user ').replace('RestartSec=30s','RestartSec=1s').replace('TimeoutStartSec=300s','TimeoutStartSec=15s')
(base/retry).write_text(source)
try:
 run('link',str(base/app),str(base/gate),str(base/retry));run('daemon-reload');run('enable',app)
 first=run('start',app,check=False)
 assert first.returncode!=0 and not started.exists(),'App started before storage became available'
 until(lambda:int(run('show',retry,'-p','NRestarts','--value').stdout.strip() or '0')>=3)
 assert not started.exists(),'Failed dependency did not block the app'
 ready.touch();until(lambda:started.exists());until(lambda:run('is-active',retry,check=False).stdout.strip()=='inactive')
 restarts=int(run('show',retry,'-p','NRestarts','--value').stdout.strip())
 run('stop',app);started.unlink();time.sleep(2.2)
 assert not started.exists(),'Recovery overrode a deliberate app stop with healthy storage'
 # A failed storage restart stops a running app and recovers after storage returns.
 run('start',app);started.unlink();ready.unlink()
 run('restart',gate,check=False)
 until(lambda:run('is-active',app,check=False).stdout.strip()!='active')
 until(lambda:run('show',retry,'-p','SubState','--value').stdout.strip()=='auto-restart')
 assert not started.exists(),'App restarted without storage'
 ready.touch();until(lambda:started.exists())
 until(lambda:run('is-active',retry,check=False).stdout.strip()=='inactive')
 # PartOf must cancel a queued retry when an operator stops the app.
 run('stop',app,gate);started.unlink();ready.unlink()
 run('start',app,check=False)
 until(lambda:run('show',retry,'-p','SubState','--value').stdout.strip()=='auto-restart')
 run('stop',app)
 ready.touch();time.sleep(2.5)
 assert not started.exists(),'Recovery overrode a deliberate stop while retrying'
 # During a still-pending mount, disable --now is the maintenance barrier:
 # later mount OnFailure notifications must not restart the disabled app.
 run('disable',app);run('link',str(base/app));run('daemon-reload');run('stop',app)
 ready.unlink();run('stop',gate)
 run('start',gate,check=False);time.sleep(1.3)
 ready.touch();run('start',retry);time.sleep(1.3)
 assert not started.exists(),'Disabled application was restarted by recovery'
 run('enable',app);run('start',app)
 assert started.exists(),'Explicit resume did not start the app'
 report={'failedDependencyBlocksApp':True,'automaticRetries':restarts,'lateStorageStartsApp':True,'manualStopRespected':True,'manualStopDuringRetries':True,'runningStorageFailureRecovered':True,'disabledAppNotRestarted':True,'explicitResumeWorks':True,'scope':'isolated user units; no production mutations','checkedAt':time.time()}
 (base/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps({'directory':str(base),**report}))
finally:
 run('stop',retry,app,gate,check=False);run('disable',app,gate,retry,check=False);run('reset-failed',retry,app,gate,check=False)
 config=pathlib.Path(os.environ.get('XDG_CONFIG_HOME',str(pathlib.Path.home()/'.config')))/'systemd/user'
 for name in [app,gate,retry]:
  link=config/name
  if link.is_symlink() and link.resolve()==base/name:link.unlink()
 run('daemon-reload',check=False)
