public class QueueJob implements Queueable {
    public void execute(QueueableContext context) {
        System.debug(context);
    }
}
