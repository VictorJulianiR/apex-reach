public class DatabaseDmlTwo {
    public static void persist(List<Account> records) {
        Database.insert(records);
    }
}
