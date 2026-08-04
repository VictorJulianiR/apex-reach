public class DatabaseDmlOne {
    public static void save(List<Account> accounts) {
        Database.insert(accounts);
    }
}
