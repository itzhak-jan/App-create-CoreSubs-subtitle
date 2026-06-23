package com.coresubsapp.processing

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Semaphore

/**
 * A serialised, cancellable work queue for the JIT processing pipeline.
 *
 * Guarantees:
 *  - Only one chunk is processed at a time (prevents thermal spikes from
 *    parallel AI inference on the same NPU/GPU).
 *  - All pending work is cancelled atomically on flush().
 *  - New work can be enqueued immediately after flush without race conditions.
 */
class ProcessingQueue {

    // One-at-a-time execution: semaphore width = 1
    private val semaphore = Semaphore(1)
    private var scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    /**
     * Enqueue a suspending work item. The lambda receives a [CancellationToken]
     * it should poll at yield points (e.g. between extract/STT/translate).
     */
    fun enqueue(tag: String = "", work: suspend () -> Unit): Job {
        return scope.launch {
            semaphore.acquire()
            try {
                work()
            } finally {
                semaphore.release()
            }
        }
    }

    /**
     * Cancel all pending and active jobs, then reset the scope so new work
     * can be enqueued immediately.
     */
    fun flush() {
        scope.cancel()
        scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    }

    fun destroy() {
        scope.cancel()
    }
}
