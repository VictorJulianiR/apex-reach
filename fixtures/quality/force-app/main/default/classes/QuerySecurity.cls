public class QuerySecurity {
    public static List<Account> userMode(Set<Id> ids) {
        return [SELECT Id, Name, Industry, Phone FROM Account WHERE Id IN :ids AND IsDeleted = false WITH USER_MODE];
    }
}
