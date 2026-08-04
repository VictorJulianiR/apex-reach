public class UiController {
    public static String load() {
        Worker worker = new WorkerImpl();
        worker.run();
        System.enqueueJob(new QueueJob());
        return 'loaded';
    }

    private static void orphanUiMethod() {
        System.debug('candidate');
    }
}
