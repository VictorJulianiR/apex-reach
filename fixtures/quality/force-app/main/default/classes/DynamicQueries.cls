public class DynamicQueries {
    public static List<SObject> known(Id caseId) {
        return Database.query('SELECT Id, Subject FROM Case WHERE Id = :caseId');
    }

    public static List<SObject> unknown(String fields) {
        return Database.query('SELECT ' + fields + ' FROM Case');
    }
}
