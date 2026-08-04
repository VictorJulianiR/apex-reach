public class SimpleAccountHandler {
    public static void apply(List<Account> records) {
        for (Account record : records) {
            record.Description = 'Maintained declaratively';
        }
    }
}
