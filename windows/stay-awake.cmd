@echo off
REM The payout runs at 00:00 UTC (02:00 summer / 01:00 winter time in Serbia). A sleeping PC misses it until it wakes.
REM This turns off sleep and hibernate while plugged in. Run as administrator. Undo: Settings -> System -> Power.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
echo Spavanje iskljuceno dok je racunar na struji.
echo Preporuka: Settings -> Windows Update -> Advanced -> Active hours, da se restart ne desi oko ponoci UTC.
pause
