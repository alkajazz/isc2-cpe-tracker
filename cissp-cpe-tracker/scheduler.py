"""
Background RSS scheduler for ISC2 CPE Tracker.

Uses APScheduler's ``BackgroundScheduler`` to run RSS fetches in a daemon
thread independently of the FastAPI request/response loop.

Job schedule
------------
- **Initial fetch** — runs 10 seconds after ``start_scheduler()`` is called,
  implemented as a one-shot ``DateTrigger`` job.  The delay is intentional:
  scheduling the fetch as a background job (rather than calling it
  synchronously in the lifespan handler) prevents uvicorn's startup from
  blocking while waiting for the RSS HTTP response.

- **Recurring fetch** — runs every 6 hours via ``IntervalTrigger``.

Both jobs share the same job function (``_fetch_job``) and write new entries
to the CSV through ``storage.add_entries()``, which deduplicates by URL so
re-running the same feed never creates duplicates.
"""

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

_scheduler = None


def _fetch_job():
    """
    Scheduled job body: fetch all configured RSS sources and persist any
    new entries to the CSV.

    Imports are deferred inside the function body to avoid circular
    import issues at module load time (rss → storage → … → scheduler).
    """
    from rss import fetch_all
    from storage import add_entries
    entries = fetch_all()
    added = add_entries(entries)
    print(f"[Scheduler] Fetched {len(entries)} items, added {len(added)} new entries")


def start_scheduler():
    """
    Initialise and start the ``BackgroundScheduler``.

    Registers two jobs:
    1. A recurring ``IntervalTrigger`` job that fires every 6 hours.
    2. A one-shot ``DateTrigger`` job that fires 10 seconds after this
       function is called (the initial fetch on app startup).

    Called once from the FastAPI lifespan context manager on startup.
    """
    global _scheduler
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(
        _fetch_job,
        trigger=IntervalTrigger(hours=6),
        id="rss_fetch",
        replace_existing=True,
    )
    _scheduler.start()
    print("[Scheduler] Started — will fetch RSS every 6 hours")
    # Run first fetch 10 seconds after startup (non-blocking)
    from apscheduler.triggers.date import DateTrigger
    from datetime import datetime, timezone, timedelta
    _scheduler.add_job(
        _fetch_job,
        trigger=DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(seconds=10)),
        id="rss_fetch_initial",
        replace_existing=True,
    )


def stop_scheduler():
    """
    Gracefully shut down the scheduler without waiting for running jobs to
    complete (``wait=False``).

    Called from the FastAPI lifespan context manager on application shutdown.
    """
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        print("[Scheduler] Stopped")
